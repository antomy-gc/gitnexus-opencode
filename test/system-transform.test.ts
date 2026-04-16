import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createSystemTransformHandler } from "../src/hooks.js"
import {
  STATIC_SYSTEM_ADDENDUM,
  STATIC_SYSTEM_ADDENDUM_SUBAGENT,
  SYSTEM_ADDENDUM_START,
} from "../src/system-addendum.js"

const alwaysMain = () => true
const alwaysSubagent = () => false

describe("createSystemTransformHandler", () => {
  it("pushes the FULL addendum for a known main session", async () => {
    const handle = createSystemTransformHandler({
      disabled: () => false,
      isMain: alwaysMain,
    })
    const out = { system: ["base prompt", "AGENTS.md content"] }
    await handle({ sessionID: "ses_main", model: {} }, out)
    assert.equal(out.system.length, 3)
    assert.equal(out.system[2], STATIC_SYSTEM_ADDENDUM)
  })

  it("pushes the LITE addendum for a known subagent session", async () => {
    const handle = createSystemTransformHandler({
      disabled: () => false,
      isMain: alwaysSubagent,
    })
    const out = { system: ["base"] }
    await handle({ sessionID: "ses_sub", model: {} }, out)
    assert.equal(out.system.length, 2)
    assert.equal(out.system[1], STATIC_SYSTEM_ADDENDUM_SUBAGENT)
  })

  it("falls back to FULL addendum when sessionID is missing (conservative default)", async () => {
    const handle = createSystemTransformHandler({
      disabled: () => false,
      isMain: () => {
        throw new Error("isMain must not be called when sessionID is absent")
      },
    })
    const out = { system: [] as string[] }
    await handle({ model: {} }, out)
    assert.equal(out.system.length, 1)
    assert.equal(out.system[0], STATIC_SYSTEM_ADDENDUM)
  })

  it("does NOT push when plugin is disabled (CLI unavailable)", async () => {
    const handle = createSystemTransformHandler({
      disabled: () => true,
      isMain: alwaysMain,
    })
    const out = { system: ["base"] }
    await handle({ sessionID: "ses_x", model: {} }, out)
    assert.deepEqual(out.system, ["base"])
  })

  it("STILL pushes when no repos are locally indexed — agent can use gitnexus_list_repos for global discovery", async () => {
    const handle = createSystemTransformHandler({
      disabled: () => false,
      isMain: alwaysMain,
    })
    const out = { system: ["base"] }
    await handle({ sessionID: "ses_main", model: {} }, out)
    assert.equal(out.system.length, 2)
    assert.ok(out.system[1]!.includes(SYSTEM_ADDENDUM_START))
  })

  it("is idempotent: a second call against the same array does not double-push", async () => {
    const handle = createSystemTransformHandler({
      disabled: () => false,
      isMain: alwaysMain,
    })
    const out = { system: ["base"] }
    await handle({ sessionID: "ses_main", model: {} }, out)
    await handle({ sessionID: "ses_main", model: {} }, out)
    assert.equal(out.system.length, 2)
  })

  it("idempotency works across full/lite variants — a pre-existing lite blocks a full push", async () => {
    const handle = createSystemTransformHandler({
      disabled: () => false,
      isMain: alwaysMain,
    })
    const out = { system: ["base", STATIC_SYSTEM_ADDENDUM_SUBAGENT] }
    await handle({ sessionID: "ses_main", model: {} }, out)
    assert.equal(out.system.length, 2)
  })

  it("respects pre-existing FULL addendum on a subagent call (does not push lite as duplicate)", async () => {
    const handle = createSystemTransformHandler({
      disabled: () => false,
      isMain: alwaysSubagent,
    })
    const out = { system: ["base", STATIC_SYSTEM_ADDENDUM] }
    await handle({ sessionID: "ses_sub", model: {} }, out)
    assert.equal(out.system.length, 2)
  })

  it("byte-identity preserved across calls of the same variant", async () => {
    const handle = createSystemTransformHandler({
      disabled: () => false,
      isMain: alwaysMain,
    })
    const a = { system: [] as string[] }
    const b = { system: [] as string[] }
    await handle({ sessionID: "ses_a", model: {} }, a)
    await handle({ sessionID: "ses_b", model: {} }, b)
    assert.strictEqual(a.system[0], b.system[0])
    assert.equal(a.system[0], STATIC_SYSTEM_ADDENDUM)
  })

  it("logs include the variant tag", async () => {
    const logs: Array<{ msg: string; level?: string }> = []
    const handle = createSystemTransformHandler({
      disabled: () => false,
      isMain: alwaysSubagent,
      log: (msg, level) => logs.push({ msg, level }),
    })
    await handle({ sessionID: "ses_sub", model: {} }, { system: [] })
    assert.equal(logs.length, 1)
    assert.match(logs[0]!.msg, /variant=subagent-lite/)
    assert.match(logs[0]!.msg, /sessionID=ses_sub/)
    assert.equal(logs[0]!.level, "info")
  })

  it("logs full variant when main", async () => {
    const logs: Array<{ msg: string; level?: string }> = []
    const handle = createSystemTransformHandler({
      disabled: () => false,
      isMain: alwaysMain,
      log: (msg, level) => logs.push({ msg, level }),
    })
    await handle({ sessionID: "ses_main", model: {} }, { system: [] })
    assert.match(logs[0]!.msg, /variant=full/)
  })

  it("does not log when it skips", async () => {
    const logs: Array<{ msg: string; level?: string }> = []
    const handle = createSystemTransformHandler({
      disabled: () => true,
      isMain: alwaysMain,
      log: (msg, level) => logs.push({ msg, level }),
    })
    await handle({ sessionID: "ses_x", model: {} }, { system: [] })
    assert.equal(logs.length, 0)
  })
})

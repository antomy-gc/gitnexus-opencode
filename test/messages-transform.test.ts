import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createMessagesTransformHandler } from "../src/hooks.js"
import { OPT_IN_MARKER, type HintCacheState } from "../src/hint-envelope.js"

type Output = {
  messages: Array<{
    info: { role: string; sessionID?: string }
    parts: Array<{ type: string; text?: string }>
  }>
}

const ENVELOPE = `<gitnexus_graph source="gitnexus" version="1" freshness="up_to_date">x</gitnexus_graph>`

function makeCache(overrides: Partial<HintCacheState> = {}): HintCacheState {
  return {
    envelope: ENVELOPE,
    freshness: "up_to_date",
    updatedAt: 1,
    ...overrides,
  }
}

function makeOutput(opts: {
  text?: string
  sessionID?: string
  noText?: boolean
  noUserMessage?: boolean
}): Output {
  if (opts.noUserMessage) {
    return { messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] }] }
  }
  const parts: Array<{ type: string; text?: string }> = opts.noText
    ? [{ type: "image" }]
    : [{ type: "text", text: opts.text ?? "user prompt" }]
  return {
    messages: [
      {
        info: { role: "user", sessionID: opts.sessionID ?? "ses_test" },
        parts,
      },
    ],
  }
}

describe("createMessagesTransformHandler", () => {
  it("main session, no marker -> injects envelope", async () => {
    const handle = createMessagesTransformHandler({
      isMain: () => true,
      getCache: () => makeCache(),
    })
    const out = makeOutput({ text: "do work" })
    await handle({}, out)
    const text = (out.messages[0]!.parts[0] as { text: string }).text
    assert.match(text, /^<gitnexus_graph/)
    assert.ok(text.endsWith("do work"), `got: ${text}`)
  })

  it("subagent session, no marker -> does NOT inject (text unchanged)", async () => {
    const handle = createMessagesTransformHandler({
      isMain: () => false,
      getCache: () => makeCache(),
    })
    const out = makeOutput({ text: "find react docs" })
    await handle({}, out)
    assert.equal((out.messages[0]!.parts[0] as { text: string }).text, "find react docs")
  })

  it("subagent session WITH marker -> injects envelope and strips marker", async () => {
    const handle = createMessagesTransformHandler({
      isMain: () => false,
      getCache: () => makeCache(),
    })
    const out = makeOutput({ text: `${OPT_IN_MARKER} list callers of foo` })
    await handle({}, out)
    const text = (out.messages[0]!.parts[0] as { text: string }).text
    assert.match(text, /^<gitnexus_graph/)
    assert.ok(text.includes("list callers of foo"))
    assert.ok(!text.includes(OPT_IN_MARKER), "marker must be stripped from final text")
  })

  it("main session with stale leading envelope -> scrubs old, injects new", async () => {
    const handle = createMessagesTransformHandler({
      isMain: () => true,
      getCache: () => makeCache(),
    })
    const stale =
      `<gitnexus_graph source="old" version="1" freshness="up_to_date">stale</gitnexus_graph>\n\n` +
      `actual user request`
    const out = makeOutput({ text: stale })
    await handle({}, out)
    const text = (out.messages[0]!.parts[0] as { text: string }).text
    // exactly one envelope at the start
    const matches = text.match(/<gitnexus_graph/g) ?? []
    assert.equal(matches.length, 1, `expected single envelope, got ${matches.length}`)
    assert.ok(text.endsWith("actual user request"))
    assert.ok(!text.includes("stale"))
  })

  it("freshness=missing -> no-op (text unchanged)", async () => {
    const handle = createMessagesTransformHandler({
      isMain: () => true,
      getCache: () => makeCache({ freshness: "missing", envelope: "" }),
    })
    const out = makeOutput({ text: "user text" })
    await handle({}, out)
    assert.equal((out.messages[0]!.parts[0] as { text: string }).text, "user text")
  })

  it("no user message -> no-op", async () => {
    const handle = createMessagesTransformHandler({
      isMain: () => true,
      getCache: () => makeCache(),
    })
    const out = makeOutput({ noUserMessage: true })
    await handle({}, out)
    // assistant message text should be unchanged
    assert.equal((out.messages[0]!.parts[0] as { text: string }).text, "hi")
  })

  it("user message has no text part (image only) -> no-op (no crash)", async () => {
    const handle = createMessagesTransformHandler({
      isMain: () => true,
      getCache: () => makeCache(),
    })
    const out = makeOutput({ noText: true })
    await assert.doesNotReject(() => handle({}, out))
    // image part untouched
    assert.equal(out.messages[0]!.parts[0]!.type, "image")
  })

  it("freshness=refreshing -> still injects (agent should see refreshing status)", async () => {
    const handle = createMessagesTransformHandler({
      isMain: () => true,
      getCache: () =>
        makeCache({
          freshness: "refreshing",
          envelope: `<gitnexus_graph source="gitnexus" version="1" freshness="refreshing">refreshing</gitnexus_graph>`,
        }),
    })
    const out = makeOutput({ text: "user text" })
    await handle({}, out)
    const text = (out.messages[0]!.parts[0] as { text: string }).text
    assert.match(text, /freshness="refreshing"/)
    assert.ok(text.endsWith("user text"))
  })

  it("turn 2: handler reads cache fresh on each call", async () => {
    let freshness: HintCacheState["freshness"] = "up_to_date"
    const handle = createMessagesTransformHandler({
      isMain: () => true,
      getCache: () => makeCache({ freshness, envelope: `<gitnexus_graph freshness="${freshness}">e</gitnexus_graph>` }),
    })

    const out1 = makeOutput({ text: "turn 1" })
    await handle({}, out1)
    assert.match((out1.messages[0]!.parts[0] as { text: string }).text, /freshness="up_to_date"/)

    // simulate cache flipping between turns
    freshness = "refreshing"

    const out2 = makeOutput({ text: "turn 2" })
    await handle({}, out2)
    assert.match((out2.messages[0]!.parts[0] as { text: string }).text, /freshness="refreshing"/)
  })

  it("two parallel calls share no state (each is self-contained)", async () => {
    const handle = createMessagesTransformHandler({
      isMain: () => true,
      getCache: () => makeCache(),
    })
    const a = makeOutput({ text: "alpha", sessionID: "ses_a" })
    const b = makeOutput({ text: "bravo", sessionID: "ses_b" })
    await Promise.all([handle({}, a), handle({}, b)])
    assert.ok((a.messages[0]!.parts[0] as { text: string }).text.endsWith("alpha"))
    assert.ok((b.messages[0]!.parts[0] as { text: string }).text.endsWith("bravo"))
  })

  it("logs an injection summary line via the supplied log", async () => {
    const logs: Array<{ msg: string; level?: string }> = []
    const handle = createMessagesTransformHandler({
      isMain: () => true,
      getCache: () => makeCache(),
      log: (msg, level) => logs.push({ msg, level }),
    })
    await handle({}, makeOutput({ text: "hi" }))
    assert.equal(logs.length, 1)
    assert.equal(logs[0]!.level, "info")
    assert.match(logs[0]!.msg, /messages\.transform injected/)
    assert.match(logs[0]!.msg, /sessionID=ses_test/)
    assert.match(logs[0]!.msg, /main=true/)
    assert.match(logs[0]!.msg, /marker=false/)
    assert.match(logs[0]!.msg, /freshness=up_to_date/)
  })
})

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createMessagesTransformHandler } from "../src/hooks.js"
import { OPT_IN_MARKER, type HintCacheState } from "../src/hint-envelope.js"
import { createLastInjectedRegistry } from "../src/last-injected.js"

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
  trailingAssistant?: boolean
  priorUserText?: string
  priorAssistantText?: string
}): Output {
  if (opts.noUserMessage) {
    return { messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] }] }
  }
  const sid = opts.sessionID ?? "ses_test"
  const messages: Output["messages"] = []
  if (opts.priorUserText !== undefined) {
    messages.push({
      info: { role: "user", sessionID: sid },
      parts: [{ type: "text", text: opts.priorUserText }],
    })
  }
  if (opts.priorAssistantText !== undefined) {
    messages.push({
      info: { role: "assistant", sessionID: sid },
      parts: [{ type: "text", text: opts.priorAssistantText }],
    })
  }
  const parts: Array<{ type: string; text?: string }> = opts.noText
    ? [{ type: "image" }]
    : [{ type: "text", text: opts.text ?? "user prompt" }]
  messages.push({
    info: { role: "user", sessionID: sid },
    parts,
  })
  if (opts.trailingAssistant) {
    messages.push({
      info: { role: "assistant", sessionID: sid },
      parts: [{ type: "text", text: "assistant reply" }],
    })
  }
  return { messages }
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

  it("HIGH fix #1: stale envelope containing OPT_IN_MARKER does NOT sticky-reinject into a subagent", async () => {
    // Regression for Oracle HIGH #1: the previous pre-scrub marker detection
    // would see OPT_IN_MARKER inside <subagent_propagation> of a stale
    // envelope and treat it as a fresh orchestrator opt-in. After the fix,
    // marker detection runs on the SCRUBBED text so only markers the
    // orchestrator actually wrote count.
    const handle = createMessagesTransformHandler({
      isMain: () => false,
      getCache: () => makeCache(),
    })
    const staleEnvelopeWithMarker =
      `<gitnexus_graph source="old" version="1" freshness="up_to_date">\n` +
      `<subagent_propagation>include ${OPT_IN_MARKER} to grant access</subagent_propagation>\n` +
      `</gitnexus_graph>\n\n` +
      `actual subagent work with NO orchestrator marker`
    const out = makeOutput({ text: staleEnvelopeWithMarker })
    await handle({}, out)
    const text = (out.messages[0]!.parts[0] as { text: string }).text
    // handler must have returned early: no fresh gitnexus envelope prepended.
    assert.ok(
      !text.startsWith('<gitnexus_graph source="gitnexus"'),
      `expected no fresh envelope, got: ${text.slice(0, 80)}`,
    )
  })

  it("HIGH fix #1: genuine fresh marker AFTER stale envelope scrub still triggers inject", async () => {
    // Positive counterpart: when the orchestrator DID write the marker and
    // there happens to be a stale envelope sitting in front of it, the handler
    // must still inject and strip the real marker.
    const handle = createMessagesTransformHandler({
      isMain: () => false,
      getCache: () => makeCache(),
    })
    const input =
      `<gitnexus_graph source="old">x</gitnexus_graph>\n\n` +
      `${OPT_IN_MARKER} list callers of foo`
    const out = makeOutput({ text: input })
    await handle({}, out)
    const text = (out.messages[0]!.parts[0] as { text: string }).text
    assert.match(text, /^<gitnexus_graph source="gitnexus"/)
    assert.ok(text.endsWith("list callers of foo"))
    assert.ok(!text.includes(OPT_IN_MARKER))
  })

  describe("dedup via lastInjected", () => {
    it("first turn: dedup miss -> injects and remembers envelope", async () => {
      const reg = createLastInjectedRegistry()
      const handle = createMessagesTransformHandler({
        isMain: () => true,
        getCache: () => makeCache(),
        lastInjected: reg,
      })
      const out = makeOutput({ text: "first prompt", sessionID: "ses_dedup_a" })
      await handle({}, out)
      const text = (out.messages[out.messages.length - 1]!.parts[0] as { text: string }).text
      assert.match(text, /^<gitnexus_graph/)
      assert.equal(reg.get("ses_dedup_a"), ENVELOPE)
    })

    it("second turn with identical envelope: dedup hit -> skips injection", async () => {
      const reg = createLastInjectedRegistry()
      reg.set("ses_dedup_b", ENVELOPE)
      const handle = createMessagesTransformHandler({
        isMain: () => true,
        getCache: () => makeCache(),
        lastInjected: reg,
      })
      const out = makeOutput({
        text: "second prompt",
        sessionID: "ses_dedup_b",
        priorUserText: `${ENVELOPE}\n\nfirst prompt`,
        priorAssistantText: "first reply",
      })
      await handle({}, out)
      const lastText = (out.messages[out.messages.length - 1]!.parts[0] as { text: string }).text
      assert.equal(lastText, "second prompt", "envelope must NOT be re-injected")
    })

    it("envelope changed (freshness flip): dedup miss -> injects new and updates memo", async () => {
      const reg = createLastInjectedRegistry()
      const oldEnvelope = `<gitnexus_graph freshness="up_to_date">x</gitnexus_graph>`
      const newEnvelope = `<gitnexus_graph freshness="refreshing">x</gitnexus_graph>`
      reg.set("ses_dedup_c", oldEnvelope)
      const handle = createMessagesTransformHandler({
        isMain: () => true,
        getCache: () => makeCache({ freshness: "refreshing", envelope: newEnvelope }),
        lastInjected: reg,
      })
      const out = makeOutput({
        text: "user text",
        sessionID: "ses_dedup_c",
        priorUserText: `${oldEnvelope}\n\nfirst prompt`,
        priorAssistantText: "first reply",
      })
      await handle({}, out)
      const lastText = (out.messages[out.messages.length - 1]!.parts[0] as { text: string }).text
      assert.match(lastText, /freshness="refreshing"/)
      assert.equal(reg.get("ses_dedup_c"), newEnvelope)
    })

    it("compaction: history without any envelope -> clears memo and re-injects", async () => {
      const reg = createLastInjectedRegistry()
      reg.set("ses_dedup_d", ENVELOPE)
      const handle = createMessagesTransformHandler({
        isMain: () => true,
        getCache: () => makeCache(),
        lastInjected: reg,
      })
      const out = makeOutput({
        text: "post-compaction prompt",
        sessionID: "ses_dedup_d",
        priorUserText: "compacted summary, no envelope here",
        priorAssistantText: "compacted reply",
      })
      await handle({}, out)
      const lastText = (out.messages[out.messages.length - 1]!.parts[0] as { text: string }).text
      assert.match(lastText, /^<gitnexus_graph/, "envelope must be re-injected after compaction")
      assert.equal(reg.get("ses_dedup_d"), ENVELOPE)
    })

    it("dedup hit MUST still strip the OPT_IN_MARKER from a subagent prompt", async () => {
      const reg = createLastInjectedRegistry()
      reg.set("ses_dedup_e", ENVELOPE)
      const handle = createMessagesTransformHandler({
        isMain: () => false,
        getCache: () => makeCache(),
        lastInjected: reg,
      })
      const out = makeOutput({
        text: `${OPT_IN_MARKER} list callers of bar`,
        sessionID: "ses_dedup_e",
        priorUserText: `${ENVELOPE}\n\nearlier subagent turn`,
      })
      await handle({}, out)
      const lastText = (out.messages[out.messages.length - 1]!.parts[0] as { text: string }).text
      assert.equal(lastText, "list callers of bar")
      assert.ok(!lastText.includes(OPT_IN_MARKER), "marker must be stripped even on dedup hit")
    })

    it("logs dedup=hit when skipping and dedup=first / dedup=changed when injecting", async () => {
      const reg = createLastInjectedRegistry()
      const logs: Array<{ msg: string; level?: string }> = []
      const handle = createMessagesTransformHandler({
        isMain: () => true,
        getCache: () => makeCache(),
        lastInjected: reg,
        log: (msg, level) => logs.push({ msg, level }),
      })

      await handle({}, makeOutput({ text: "t1", sessionID: "ses_dedup_log" }))
      await handle({}, makeOutput({
        text: "t2",
        sessionID: "ses_dedup_log",
        priorUserText: `${ENVELOPE}\n\nt1`,
      }))

      assert.equal(logs.length, 2)
      assert.match(logs[0]!.msg, /messages\.transform injected/)
      assert.match(logs[0]!.msg, /dedup=first/)
      assert.match(logs[1]!.msg, /messages\.transform skipped \(dedup hit\)/)
    })

    it("two sessions deduplicate independently", async () => {
      const reg = createLastInjectedRegistry()
      reg.set("ses_x", ENVELOPE)
      const handle = createMessagesTransformHandler({
        isMain: () => true,
        getCache: () => makeCache(),
        lastInjected: reg,
      })
      const xOut = makeOutput({
        text: "x t2",
        sessionID: "ses_x",
        priorUserText: `${ENVELOPE}\n\nx t1`,
      })
      const yOut = makeOutput({ text: "y t1", sessionID: "ses_y" })
      await Promise.all([handle({}, xOut), handle({}, yOut)])

      const xText = (xOut.messages[xOut.messages.length - 1]!.parts[0] as { text: string }).text
      const yText = (yOut.messages[yOut.messages.length - 1]!.parts[0] as { text: string }).text
      assert.equal(xText, "x t2", "session x: dedup hit")
      assert.match(yText, /^<gitnexus_graph/, "session y: first inject")
    })

    it("backward compat: handler omitting lastInjected still injects on every call", async () => {
      const handle = createMessagesTransformHandler({
        isMain: () => true,
        getCache: () => makeCache(),
      })
      const out1 = makeOutput({ text: "t1", sessionID: "ses_compat" })
      const out2 = makeOutput({
        text: "t2",
        sessionID: "ses_compat",
        priorUserText: `${ENVELOPE}\n\nt1`,
      })
      await handle({}, out1)
      await handle({}, out2)
      const t2 = (out2.messages[out2.messages.length - 1]!.parts[0] as { text: string }).text
      assert.match(t2, /^<gitnexus_graph/, "no lastInjected -> still injects")
    })
  })

  it("LOW fix #7: trailing assistant message -> no inject (last message not user)", async () => {
    // After this change the handler only injects when the LAST message is a
    // user message. For internal follow-up calls that end with an assistant
    // turn, the plugin must not touch the user message above it.
    const handle = createMessagesTransformHandler({
      isMain: () => true,
      getCache: () => makeCache(),
    })
    const out = makeOutput({ text: "earlier user turn", trailingAssistant: true })
    await handle({}, out)
    // user message text untouched
    assert.equal((out.messages[0]!.parts[0] as { text: string }).text, "earlier user turn")
    // assistant message untouched
    assert.equal((out.messages[1]!.parts[0] as { text: string }).text, "assistant reply")
  })
})

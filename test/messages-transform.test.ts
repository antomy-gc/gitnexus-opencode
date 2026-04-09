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
  trailingAssistant?: boolean
}): Output {
  if (opts.noUserMessage) {
    return { messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] }] }
  }
  const parts: Array<{ type: string; text?: string }> = opts.noText
    ? [{ type: "image" }]
    : [{ type: "text", text: opts.text ?? "user prompt" }]
  const messages: Output["messages"] = [
    {
      info: { role: "user", sessionID: opts.sessionID ?? "ses_test" },
      parts,
    },
  ]
  if (opts.trailingAssistant) {
    messages.push({
      info: { role: "assistant", sessionID: opts.sessionID ?? "ses_test" },
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

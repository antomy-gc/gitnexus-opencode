import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  createHintEnvelopeState,
  scrubPromptGitnexusBlocks,
  stripOptInMarker,
  OPT_IN_MARKER,
  type HintEnvelopeState,
} from "../src/hint-envelope.js"
import type { RepoInfo } from "../src/discovery.js"

function repo(name: string, opts: { hasIndex?: boolean; isStale?: boolean; path?: string } = {}): RepoInfo {
  return {
    name,
    path: opts.path ?? `/tmp/${name}`,
    hasIndex: opts.hasIndex ?? true,
    isStale: opts.isStale ?? false,
  }
}

describe("HintEnvelopeState: rebuildHintCache + freshness", () => {
  let state: HintEnvelopeState
  beforeEach(() => {
    state = createHintEnvelopeState()
  })

  it("empty repo list -> freshness=missing, empty envelope", () => {
    state.rebuildHintCache([])
    const c = state.getHintCache()
    assert.equal(c.freshness, "missing")
    assert.equal(c.envelope, "")
  })

  it("only unindexed repos -> freshness=missing", () => {
    state.rebuildHintCache([repo("a", { hasIndex: false })])
    assert.equal(state.getHintCache().freshness, "missing")
  })

  it("indexed and not stale -> freshness=up_to_date", () => {
    state.rebuildHintCache([repo("myproj", { hasIndex: true, isStale: false })])
    const c = state.getHintCache()
    assert.equal(c.freshness, "up_to_date")
    assert.match(c.envelope, /freshness="up_to_date"/)
  })

  it("indexed and stale -> freshness=may_be_stale", () => {
    state.rebuildHintCache([repo("myproj", { hasIndex: true, isStale: true })])
    const c = state.getHintCache()
    assert.equal(c.freshness, "may_be_stale")
    assert.match(c.envelope, /freshness="may_be_stale"/)
  })

  it("markRefreshing makes the cache report freshness=refreshing on next rebuild", () => {
    const r = repo("myproj", { hasIndex: true, isStale: false, path: "/tmp/myproj" })
    state.markRefreshing("/tmp/myproj")
    state.rebuildHintCache([r])
    assert.equal(state.getHintCache().freshness, "refreshing")
  })

  it("markRefreshDone clears the refreshing flag for the next rebuild", () => {
    const r = repo("myproj", { hasIndex: true, isStale: false, path: "/tmp/myproj" })
    state.markRefreshing("/tmp/myproj")
    state.rebuildHintCache([r])
    assert.equal(state.getHintCache().freshness, "refreshing")
    state.markRefreshDone("/tmp/myproj")
    state.rebuildHintCache([r])
    assert.equal(state.getHintCache().freshness, "up_to_date")
  })

  it("refreshing wins over stale when both flags apply", () => {
    const r = repo("myproj", { hasIndex: true, isStale: true, path: "/tmp/myproj" })
    state.markRefreshing("/tmp/myproj")
    state.rebuildHintCache([r])
    assert.equal(state.getHintCache().freshness, "refreshing")
  })

  it("envelope contains required XML sections (data only — rules live in system prompt)", () => {
    state.rebuildHintCache([repo("myproj")])
    const env = state.getHintCache().envelope
    assert.match(env, /<gitnexus_graph\b/)
    assert.match(env, /<summary>/)
    assert.match(env, /<indexed_repos>/)
    assert.match(env, /<rules>/)
    assert.match(env, /<\/gitnexus_graph>/)
  })

  it("envelope no longer carries the static rule sections (they moved to system prompt)", () => {
    state.rebuildHintCache([repo("myproj")])
    const env = state.getHintCache().envelope
    assert.ok(!env.includes("<preferred_tools>"))
    assert.ok(!env.includes("<when_to_use>"))
    assert.ok(!env.includes("<subagent_propagation>"))
  })

  it("envelope escapes XML special chars in repo names and paths", () => {
    state.rebuildHintCache([repo("weird<name>&\"'", { path: "/tmp/<weird>" })])
    const env = state.getHintCache().envelope
    assert.match(env, /name="weird&lt;name&gt;&amp;&quot;&apos;"/)
    assert.match(env, /path="\/tmp\/&lt;weird&gt;"/)
  })

  it("envelope cross-references the OPT_IN_MARKER as a reminder back to system rules", () => {
    state.rebuildHintCache([repo("myproj")])
    const env = state.getHintCache().envelope
    assert.ok(env.includes(OPT_IN_MARKER))
  })

  it("two independent HintEnvelopeState instances do not share state", () => {
    const a = createHintEnvelopeState()
    const b = createHintEnvelopeState()
    a.rebuildHintCache([repo("alpha")])
    b.rebuildHintCache([repo("bravo")])
    assert.match(a.getHintCache().envelope, /name="alpha"/)
    assert.match(b.getHintCache().envelope, /name="bravo"/)
    // a's cache must not mention b's repo and vice versa
    assert.ok(!a.getHintCache().envelope.includes("bravo"))
    assert.ok(!b.getHintCache().envelope.includes("alpha"))
  })

  it("markRefreshing on one instance does NOT affect another instance", () => {
    const a = createHintEnvelopeState()
    const b = createHintEnvelopeState()
    a.markRefreshing("/tmp/shared")
    a.rebuildHintCache([repo("shared", { path: "/tmp/shared" })])
    b.rebuildHintCache([repo("shared", { path: "/tmp/shared" })])
    assert.equal(a.getHintCache().freshness, "refreshing")
    assert.equal(b.getHintCache().freshness, "up_to_date")
  })
})

describe("scrubPromptGitnexusBlocks", () => {
  it("returns text unchanged when there is no envelope", () => {
    assert.equal(scrubPromptGitnexusBlocks("hello world"), "hello world")
  })

  it("strips a single leading envelope and following blank lines", () => {
    const input = `<gitnexus_graph source="x">stuff</gitnexus_graph>\n\nuser text`
    assert.equal(scrubPromptGitnexusBlocks(input), "user text")
  })

  it("strips multiple stacked leading envelopes", () => {
    const input =
      `<gitnexus_graph>a</gitnexus_graph>\n` +
      `<gitnexus_graph>b</gitnexus_graph>\n\n` +
      `payload`
    assert.equal(scrubPromptGitnexusBlocks(input), "payload")
  })

  it("preserves text AFTER the leading envelope verbatim, including code", () => {
    const input =
      `<gitnexus_graph>x</gitnexus_graph>\n\n` +
      `function foo() {\n  return 1\n}`
    assert.equal(
      scrubPromptGitnexusBlocks(input),
      `function foo() {\n  return 1\n}`,
    )
  })

  it("does NOT remove envelopes that are not at the start of the text", () => {
    const input = `prefix <gitnexus_graph>x</gitnexus_graph> suffix`
    assert.equal(scrubPromptGitnexusBlocks(input), input)
  })
})

describe("stripOptInMarker", () => {
  it("returns text unchanged when marker is absent", () => {
    assert.equal(stripOptInMarker("plain text"), "plain text")
  })

  it("strips a leading inline marker and trims leading spaces", () => {
    assert.equal(stripOptInMarker(`${OPT_IN_MARKER} find foo`), "find foo")
  })

  it("strips a solo-line marker at the start without leaving a blank line", () => {
    assert.equal(
      stripOptInMarker(`${OPT_IN_MARKER}\nreal instructions`),
      "real instructions",
    )
  })

  it("strips a solo-line marker in the middle and joins the two neighboring lines", () => {
    assert.equal(
      stripOptInMarker(`foo\n${OPT_IN_MARKER}\nbar`),
      "foo\nbar",
    )
  })

  it("strips a solo-line marker surrounded by horizontal whitespace", () => {
    assert.equal(
      stripOptInMarker(`   ${OPT_IN_MARKER}   \nreal instructions`),
      "real instructions",
    )
  })

  it("preserves multi-line code blocks after an inline marker", () => {
    const input =
      `${OPT_IN_MARKER} refactor this:\n\n\`\`\`ts\nfunction foo() {\n  return 1\n}\n\`\`\``
    const expected =
      "refactor this:\n\n```ts\nfunction foo() {\n  return 1\n}\n```"
    assert.equal(stripOptInMarker(input), expected)
  })

  it("preserves newlines and indentation around a mid-sentence marker", () => {
    const input = `line1\nline2 ${OPT_IN_MARKER} still line2\n  indented line3`
    // inline strip leaves a double space where the marker used to be,
    // but the newlines and indentation are untouched
    assert.equal(
      stripOptInMarker(input),
      "line1\nline2  still line2\n  indented line3",
    )
  })

  it("strips marker-only input to empty string", () => {
    assert.equal(stripOptInMarker(OPT_IN_MARKER), "")
  })

  it("strips marker-only-with-newline to empty string", () => {
    assert.equal(stripOptInMarker(`${OPT_IN_MARKER}\n`), "")
  })

  it("strips multiple inline occurrences but preserves interior whitespace", () => {
    // two separate inline markers leave a double space each; that is
    // intentional, because we do NOT rewrite user whitespace.
    assert.equal(
      stripOptInMarker(`${OPT_IN_MARKER} a ${OPT_IN_MARKER} b`),
      "a  b",
    )
  })
})

describe("OPT_IN_MARKER constant", () => {
  it("is the documented literal", () => {
    assert.equal(OPT_IN_MARKER, "[[gitnexus:graph]]")
  })
})

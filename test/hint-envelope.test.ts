import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  rebuildHintCache,
  getHintCache,
  resetHintCache,
  markRefreshing,
  markRefreshDone,
  scrubPromptGitnexusBlocks,
  stripOptInMarker,
  OPT_IN_MARKER,
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

describe("rebuildHintCache + freshness", () => {
  beforeEach(() => resetHintCache())

  it("empty repo list -> freshness=missing, empty envelope", () => {
    rebuildHintCache([])
    const c = getHintCache()
    assert.equal(c.freshness, "missing")
    assert.equal(c.envelope, "")
  })

  it("only unindexed repos -> freshness=missing", () => {
    rebuildHintCache([repo("a", { hasIndex: false })])
    assert.equal(getHintCache().freshness, "missing")
  })

  it("indexed and not stale -> freshness=up_to_date", () => {
    rebuildHintCache([repo("myproj", { hasIndex: true, isStale: false })])
    const c = getHintCache()
    assert.equal(c.freshness, "up_to_date")
    assert.match(c.envelope, /freshness="up_to_date"/)
  })

  it("indexed and stale -> freshness=may_be_stale", () => {
    rebuildHintCache([repo("myproj", { hasIndex: true, isStale: true })])
    const c = getHintCache()
    assert.equal(c.freshness, "may_be_stale")
    assert.match(c.envelope, /freshness="may_be_stale"/)
  })

  it("markRefreshing makes the cache report freshness=refreshing on next rebuild", () => {
    const r = repo("myproj", { hasIndex: true, isStale: false, path: "/tmp/myproj" })
    markRefreshing("/tmp/myproj")
    rebuildHintCache([r])
    assert.equal(getHintCache().freshness, "refreshing")
  })

  it("markRefreshDone clears the refreshing flag for the next rebuild", () => {
    const r = repo("myproj", { hasIndex: true, isStale: false, path: "/tmp/myproj" })
    markRefreshing("/tmp/myproj")
    rebuildHintCache([r])
    assert.equal(getHintCache().freshness, "refreshing")
    markRefreshDone("/tmp/myproj")
    rebuildHintCache([r])
    assert.equal(getHintCache().freshness, "up_to_date")
  })

  it("refreshing wins over stale when both flags apply", () => {
    const r = repo("myproj", { hasIndex: true, isStale: true, path: "/tmp/myproj" })
    markRefreshing("/tmp/myproj")
    rebuildHintCache([r])
    assert.equal(getHintCache().freshness, "refreshing")
  })

  it("envelope contains required XML sections", () => {
    rebuildHintCache([repo("myproj")])
    const env = getHintCache().envelope
    assert.match(env, /<gitnexus_graph\b/)
    assert.match(env, /<summary>/)
    assert.match(env, /<indexed_repos>/)
    assert.match(env, /<preferred_tools>/)
    assert.match(env, /<when_to_use>/)
    assert.match(env, /<subagent_propagation>/)
    assert.match(env, /<\/gitnexus_graph>/)
  })

  it("envelope escapes XML special chars in repo names and paths", () => {
    rebuildHintCache([repo("weird<name>&\"'", { path: "/tmp/<weird>" })])
    const env = getHintCache().envelope
    // raw < > & " ' must NOT appear inside the repo attribute / path text
    assert.match(env, /name="weird&lt;name&gt;&amp;&quot;&apos;"/)
    assert.match(env, />\/tmp\/&lt;weird&gt;</)
  })

  it("envelope mentions the OPT_IN_MARKER literal in the propagation section", () => {
    rebuildHintCache([repo("myproj")])
    const env = getHintCache().envelope
    assert.ok(env.includes(OPT_IN_MARKER))
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

  it("strips a leading marker and trims", () => {
    assert.equal(stripOptInMarker(`${OPT_IN_MARKER} find foo`), "find foo")
  })

  it("strips a marker in the middle and normalizes whitespace", () => {
    assert.equal(
      stripOptInMarker(`find foo ${OPT_IN_MARKER} bar`),
      "find foo bar",
    )
  })

  it("strips marker-only input to empty string", () => {
    assert.equal(stripOptInMarker(OPT_IN_MARKER), "")
  })

  it("strips multiple occurrences", () => {
    assert.equal(
      stripOptInMarker(`${OPT_IN_MARKER} a ${OPT_IN_MARKER} b`),
      "a b",
    )
  })
})

describe("OPT_IN_MARKER constant", () => {
  it("is the documented literal", () => {
    assert.equal(OPT_IN_MARKER, "[[gitnexus:graph]]")
  })
})

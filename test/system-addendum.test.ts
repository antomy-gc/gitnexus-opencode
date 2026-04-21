import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  STATIC_SYSTEM_ADDENDUM,
  STATIC_SYSTEM_ADDENDUM_SUBAGENT,
  SYSTEM_ADDENDUM_START,
  SYSTEM_ADDENDUM_END,
  systemAddendumPresent,
} from "../src/system-addendum.js"
import { OPT_IN_MARKER } from "../src/hint-envelope.js"

describe("STATIC_SYSTEM_ADDENDUM", () => {
  it("is wrapped between the start and end sentinels", () => {
    assert.ok(STATIC_SYSTEM_ADDENDUM.startsWith(SYSTEM_ADDENDUM_START))
    assert.ok(STATIC_SYSTEM_ADDENDUM.endsWith(SYSTEM_ADDENDUM_END))
  })

  it("is a frozen module-level string, not a builder (prefix-cache contract)", () => {
    assert.equal(typeof STATIC_SYSTEM_ADDENDUM, "string")
    const a = STATIC_SYSTEM_ADDENDUM
    const b = STATIC_SYSTEM_ADDENDUM
    assert.strictEqual(a, b)
  })

  it("contains no Date.now / random / env-derived bytes that would drift between turns", () => {
    const yearRe = /\b20\d{2}-\d{2}-\d{2}/
    assert.ok(!yearRe.test(STATIC_SYSTEM_ADDENDUM), "addendum must not embed dates")
  })

  it("contains the OPT_IN_MARKER literal so the rule references the same marker the plugin matches", () => {
    assert.ok(STATIC_SYSTEM_ADDENDUM.includes(OPT_IN_MARKER))
  })

  it("documents both the include-marker and omit-marker subagent_type lists", () => {
    assert.match(STATIC_SYSTEM_ADDENDUM, /INCLUDE for code agents/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /OMIT for non-code agents/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /explore/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /librarian/)
  })

  it("documents the path-based override rule", () => {
    assert.match(STATIC_SYSTEM_ADDENDUM, /INCLUDE regardless of agent type when the prompt references an absolute\s+path/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /repo path=/)
  })

  it("documents gitnexus_list_repos as the fallback when the user-message envelope is absent", () => {
    assert.match(STATIC_SYSTEM_ADDENDUM, /gitnexus_list_repos/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /If absent/)
  })

  it("frames the build-graph rule as a run-by-default for unindexed repos (not a predicted-cost threshold)", () => {
    assert.match(STATIC_SYSTEM_ADDENDUM, /When to build a graph yourself/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /gitnexus_analyze/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /Default:/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /unindexed repo more than trivially/)
  })

  it("keeps the 30-120s cost line so the model can weigh the upfront wait", () => {
    assert.match(STATIC_SYSTEM_ADDENDUM, /30-120s/)
  })

  it("narrows the skip carve-out to single open file only (no broad 'one-off lookup' escape hatch)", () => {
    assert.match(STATIC_SYSTEM_ADDENDUM, /"Trivially"\s*=\s*one file, already open/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /without understanding the rest of the repo/)
  })

  it("enumerates prompt-shape triggers that cover both research and implementation intents", () => {
    assert.match(STATIC_SYSTEM_ADDENDUM, /"look into…"/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /"how does…"/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /"why…"/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /"add…"/)
    assert.match(STATIC_SYSTEM_ADDENDUM, /exploration, debugging, multi-file changes/)
  })

  it("justifies the upfront wait with a concrete break-even bound (graph outpaces grep within 2 tool calls)", () => {
    assert.match(STATIC_SYSTEM_ADDENDUM, /graph queries will outpace grep within 2 tool calls/)
  })

  it("names the GitNexus MCP tools the agent should prefer", () => {
    for (const tool of [
      "gitnexus_query",
      "gitnexus_context",
      "gitnexus_impact",
      "gitnexus_cypher",
      "gitnexus_list_repos",
    ]) {
      assert.ok(
        STATIC_SYSTEM_ADDENDUM.includes(tool),
        `expected addendum to mention ${tool}`,
      )
    }
  })

  it("contains no per-instance interpolations (cache invariant)", () => {
    assert.ok(!STATIC_SYSTEM_ADDENDUM.includes("undefined"))
    assert.ok(!STATIC_SYSTEM_ADDENDUM.includes("${"))
    assert.ok(!STATIC_SYSTEM_ADDENDUM.includes("[object"))
  })
})

describe("STATIC_SYSTEM_ADDENDUM_SUBAGENT", () => {
  it("is wrapped between the same start/end sentinels as the full addendum", () => {
    assert.ok(STATIC_SYSTEM_ADDENDUM_SUBAGENT.startsWith(SYSTEM_ADDENDUM_START))
    assert.ok(STATIC_SYSTEM_ADDENDUM_SUBAGENT.endsWith(SYSTEM_ADDENDUM_END))
  })

  it("is meaningfully shorter than the full addendum (subagent gets a lite version)", () => {
    assert.ok(
      STATIC_SYSTEM_ADDENDUM_SUBAGENT.length < STATIC_SYSTEM_ADDENDUM.length / 2,
      `expected lite ≤ half of full, got lite=${STATIC_SYSTEM_ADDENDUM_SUBAGENT.length} full=${STATIC_SYSTEM_ADDENDUM.length}`,
    )
  })

  it("retains the envelope contract (so subagent can use repo= parameter and self-discover via list_repos)", () => {
    assert.match(STATIC_SYSTEM_ADDENDUM_SUBAGENT, /<gitnexus_graph>/)
    assert.match(STATIC_SYSTEM_ADDENDUM_SUBAGENT, /gitnexus_list_repos/)
    assert.match(STATIC_SYSTEM_ADDENDUM_SUBAGENT, /`repo`\s+parameter/)
  })

  it("retains the tool preference list", () => {
    for (const tool of [
      "gitnexus_query",
      "gitnexus_context",
      "gitnexus_impact",
      "gitnexus_cypher",
      "gitnexus_list_repos",
    ]) {
      assert.ok(
        STATIC_SYSTEM_ADDENDUM_SUBAGENT.includes(tool),
        `expected lite addendum to mention ${tool}`,
      )
    }
  })

  it("OMITS subagent propagation rules (subagent rarely spawns further subagents)", () => {
    assert.ok(!STATIC_SYSTEM_ADDENDUM_SUBAGENT.includes(OPT_IN_MARKER))
    assert.ok(!/Subagent propagation/i.test(STATIC_SYSTEM_ADDENDUM_SUBAGENT))
    assert.ok(!/INCLUDE for code agents/i.test(STATIC_SYSTEM_ADDENDUM_SUBAGENT))
  })

  it("OMITS the build-graph-yourself rule (gitnexus_analyze is intended for the main agent only)", () => {
    assert.ok(!STATIC_SYSTEM_ADDENDUM_SUBAGENT.includes("gitnexus_analyze"))
    assert.ok(!/When to build a graph/i.test(STATIC_SYSTEM_ADDENDUM_SUBAGENT))
  })

  it("contains no per-instance interpolations (cache invariant)", () => {
    assert.ok(!STATIC_SYSTEM_ADDENDUM_SUBAGENT.includes("undefined"))
    assert.ok(!STATIC_SYSTEM_ADDENDUM_SUBAGENT.includes("${"))
    assert.ok(!STATIC_SYSTEM_ADDENDUM_SUBAGENT.includes("[object"))
  })
})

describe("systemAddendumPresent", () => {
  it("returns false on empty array", () => {
    assert.equal(systemAddendumPresent([]), false)
  })

  it("returns false when no section contains the start sentinel", () => {
    assert.equal(systemAddendumPresent(["base prompt", "AGENTS.md content"]), false)
  })

  it("returns true when a section contains the full addendum", () => {
    assert.equal(systemAddendumPresent(["base", STATIC_SYSTEM_ADDENDUM]), true)
  })

  it("returns true when only the start sentinel is present (defensive: partial paste)", () => {
    assert.equal(systemAddendumPresent([SYSTEM_ADDENDUM_START + " stub"]), true)
  })

  it("returns true if the sentinel is embedded mid-section, not at the start", () => {
    assert.equal(
      systemAddendumPresent([`prelude\n${SYSTEM_ADDENDUM_START}\nrules\n${SYSTEM_ADDENDUM_END}`]),
      true,
    )
  })
})

import { OPT_IN_MARKER } from "./hint-envelope.js"

/**
 * Stable byte-identical sentinels marking the start/end of any gitnexus
 * addendum (full or lite) inside the system prompt. Used for:
 *   - idempotency: a `experimental.chat.system.transform` hook can detect
 *     whether a gitnexus addendum is already present in `output.system` and
 *     skip re-pushing on a subsequent invocation within the same turn.
 *   - debug visibility: anyone reading the system prompt in a log can find
 *     the plugin's contribution without parsing.
 *
 * IMPORTANT: changing these strings invalidates provider prefix caches for
 * every existing session. Treat as a wire format.
 */
export const SYSTEM_ADDENDUM_START = "<!-- gitnexus:system:start -->"
export const SYSTEM_ADDENDUM_END = "<!-- gitnexus:system:end -->"

/**
 * Full system-prompt addendum for MAIN (orchestrator) sessions: covers the
 * envelope contract, subagent propagation rules, tool preference, and the
 * "build a graph yourself" cost/benefit rule.
 *
 * This string is intentionally a module-level constant rather than a
 * function: it must be byte-identical across every turn of every main
 * session so that the provider's system-prompt prefix cache (Anthropic, etc.)
 * keeps matching and we never pay uncached input cost for these tokens
 * after the first turn of a session.
 *
 * Anything that varies per repository (names, paths, freshness, symbol
 * counts) lives in the dynamic user-message envelope in hint-envelope.ts.
 * Do NOT interpolate per-instance data into this string.
 */
export const STATIC_SYSTEM_ADDENDUM = `${SYSTEM_ADDENDUM_START}
# GitNexus knowledge graph

A \`<gitnexus_graph>\` envelope is delivered in user messages with the live
list of indexed repos and their freshness — re-read it each turn. If absent
(cwd has no local indexes), call \`gitnexus_list_repos\` once to discover
repos indexed elsewhere; target them via the \`repo\` parameter on any
gitnexus_* tool.

## Subagent propagation

Spawned subagents do NOT inherit the user-message envelope. Include the
literal marker \`${OPT_IN_MARKER}\` in the prompt to grant graph access —
the plugin swaps it for the envelope and strips the marker.

- INCLUDE for code agents: explore, deep, build, quick, refactor, sisyphus-junior, general
- OMIT for non-code agents: librarian, oracle, Momus, Metis, Prometheus, multimodal-looker
- INCLUDE regardless of agent type when the prompt references an absolute
  path under any \`<repo path="...">\` in the envelope — without the marker
  the subagent will Grep the tree where one gitnexus_query would suffice.

## Tools (your own calls)

Prefer for structural questions: gitnexus_query, gitnexus_context,
gitnexus_impact, gitnexus_cypher, gitnexus_list_repos. Keep Grep/Read for
literal strings, configs, file-level navigation.

## When to build a graph yourself

If you expect 3+ structural queries on a repo NOT in \`<indexed_repos>\`, run
gitnexus_analyze first. Cost: 3-120s once (repo-size dependent). Benefit:
each query then takes milliseconds and returns typed relations
(CALLS/EXTENDS/ACCESSES), not raw grep matches; cross-flow questions
("trace endpoint to DB write") become one cypher call instead of multi-step
manual stitching.

Triggers: user asks "how does X work" on a new repo, you are about to spawn
a code subagent for an unindexed repo, or you expect 3+ gitnexus_query calls.

Do NOT analyze for one-off lookups or single-file edits — won't pay back.
${SYSTEM_ADDENDUM_END}`

/**
 * Lite system-prompt addendum for SUBAGENT sessions: covers only what the
 * subagent itself uses — the envelope contract (so it can do its own
 * `gitnexus_list_repos` discovery if the orchestrator forgot the marker)
 * and the tool preference list.
 *
 * Deliberately omits:
 *   - Subagent propagation rules — subagents rarely spawn further subagents.
 *   - "When to build a graph yourself" — gitnexus_analyze is intended for
 *     the main agent only (see its tool description); a short-lived
 *     subagent should not initiate a 3-120s background indexing job.
 *
 * This save roughly 60-65% of the addendum size for every subagent system
 * prompt while keeping the subagent functionally complete for its own work.
 */
export const STATIC_SYSTEM_ADDENDUM_SUBAGENT = `${SYSTEM_ADDENDUM_START}
# GitNexus knowledge graph

If a \`<gitnexus_graph>\` envelope is delivered in your user messages, it lists
the repos currently indexed and reachable via the \`repo\` parameter. Re-read
it each turn for live data. If absent, call \`gitnexus_list_repos\` once to
discover repos indexed elsewhere on the machine.

## Tools (your own calls)

Prefer for structural questions: gitnexus_query, gitnexus_context,
gitnexus_impact, gitnexus_cypher, gitnexus_list_repos. Keep Grep/Read for
literal strings, configs, file-level navigation.
${SYSTEM_ADDENDUM_END}`

export function systemAddendumPresent(sections: readonly string[]): boolean {
  for (const section of sections) {
    if (section.includes(SYSTEM_ADDENDUM_START)) return true
  }
  return false
}

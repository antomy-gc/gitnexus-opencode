import { discoverRepos, type RepoInfo } from "./discovery.js"

/**
 * State of the cached graph hint envelope.
 *
 * - `up_to_date`  — at least one repo is indexed and not stale, no refresh in flight
 * - `refreshing`  — at least one repo is currently being analyzed in background
 * - `may_be_stale` — at least one indexed repo is stale (HEAD drifted) and no refresh active
 * - `missing`     — no repo is indexed at all (envelope is empty, hook should skip injection)
 */
export type GraphFreshness = "up_to_date" | "refreshing" | "may_be_stale" | "missing"

export interface HintCacheState {
  envelope: string
  freshness: GraphFreshness
  updatedAt: number
}

/**
 * Stable opt-in marker the orchestrator writes into a subagent prompt to grant
 * graph access to that subagent. The plugin's messages.transform hook detects
 * this marker, prepends the envelope, and strips the marker from the prompt.
 */
export const OPT_IN_MARKER = "[[gitnexus:graph]]"

const refreshing = new Set<string>()

let cache: HintCacheState = {
  envelope: "",
  freshness: "missing",
  updatedAt: 0,
}

export function markRefreshing(repoPath: string): void {
  refreshing.add(repoPath)
}

export function markRefreshDone(repoPath: string): void {
  refreshing.delete(repoPath)
}

export function getHintCache(): HintCacheState {
  return cache
}

export function resetHintCache(): void {
  refreshing.clear()
  cache = { envelope: "", freshness: "missing", updatedAt: 0 }
}

/**
 * Rebuild the cached envelope from a list of repos. Pure function over the
 * repo list + the in-flight `refreshing` set. Called by:
 *   - session.created handler (initial build)
 *   - scheduleAnalyze (before + after background analyze, to flip freshness)
 */
export function rebuildHintCache(repos: RepoInfo[]): void {
  const indexed = repos.filter((r) => r.hasIndex)

  if (indexed.length === 0) {
    cache = { envelope: "", freshness: "missing", updatedAt: Date.now() }
    return
  }

  const anyRefreshing = indexed.some((r) => refreshing.has(r.path))
  const anyStale = indexed.some((r) => r.isStale)

  let freshness: GraphFreshness
  if (anyRefreshing) freshness = "refreshing"
  else if (anyStale) freshness = "may_be_stale"
  else freshness = "up_to_date"

  cache = {
    envelope: buildEnvelope(indexed, freshness),
    freshness,
    updatedAt: Date.now(),
  }
}

/**
 * Convenience wrapper combining repo discovery + cache rebuild. Lives in this
 * module (rather than hooks.ts) so the index.ts hook handler can import it
 * without creating a circular dependency on hooks.ts.
 */
export function refreshHintCache(scanRoot: string): void {
  const repos = discoverRepos(scanRoot)
  rebuildHintCache(repos)
}

const LEADING_ENVELOPE_RE =
  /^<gitnexus_graph\b[^>]*>[\s\S]*?<\/gitnexus_graph>(?:\r?\n){0,2}/

/**
 * Idempotency scrubber: remove any leading `<gitnexus_graph>...</gitnexus_graph>`
 * blocks (with their trailing newlines) so a stale envelope from a previous
 * turn or compaction doesn't accumulate when we prepend the fresh one.
 *
 * Only matches at start-of-text — envelopes embedded inside user content (e.g.
 * pasted code) are left alone, since they were not put there by us.
 */
export function scrubPromptGitnexusBlocks(text: string): string {
  let scrubbed = text
  while (LEADING_ENVELOPE_RE.test(scrubbed)) {
    scrubbed = scrubbed.replace(LEADING_ENVELOPE_RE, "")
  }
  return scrubbed
}

/**
 * Remove every occurrence of OPT_IN_MARKER from a prompt without touching
 * any other whitespace. Multi-line structure, indentation, markdown, and
 * code fences are preserved verbatim.
 *
 * If the marker sat alone on its own line, the now-empty line is removed
 * so the orchestrator can write:
 *
 *     [[gitnexus:graph]]
 *     real instructions here
 *
 * and the subagent sees just `real instructions here` without a leading
 * blank line. Any other blank lines the user wrote are left intact.
 */
export function stripOptInMarker(text: string): string {
  if (!text.includes(OPT_IN_MARKER)) return text

  // Step 1: if a marker sits alone on its own line (optionally surrounded by
  // horizontal whitespace), remove the entire line including its newline.
  //   "[[gitnexus:graph]]\n..."    -> "..."
  //   "foo\n   [[gitnexus:graph]]   \nbar" -> "foo\nbar"
  const SOLO_LINE = new RegExp(
    `(^|\r?\n)[ \t]*${escapeRegex(OPT_IN_MARKER)}[ \t]*(?=\r?\n|$)\r?\n?`,
    "g",
  )
  let out = text.replace(SOLO_LINE, (_m, lead) => lead)

  // Step 2: strip any remaining inline occurrences verbatim. The surrounding
  // whitespace is left alone so interior code / markdown / structure survives.
  out = out.split(OPT_IN_MARKER).join("")

  // Step 3: trim only the very first leading horizontal whitespace run and the
  // very last trailing horizontal whitespace run, so the envelope still gets a
  // clean join target. Interior newlines are preserved; leading newlines left
  // by the user are also preserved.
  return out.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "")
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function freshnessSummary(freshness: GraphFreshness): string {
  switch (freshness) {
    case "up_to_date":
      return "Code knowledge graph is available. Graph is current."
    case "refreshing":
      return "Code knowledge graph is available. A background refresh is in progress; some symbols may be from the previous HEAD until it completes."
    case "may_be_stale":
      return "Code knowledge graph is available but may be stale (HEAD has moved since last analyze). Results are still useful for structure; re-run gitnexus_analyze if precision matters."
    case "missing":
      return ""
  }
}

function buildEnvelope(indexed: RepoInfo[], freshness: GraphFreshness): string {
  const primary = indexed[0]!.name
  const repoLines = indexed
    .map((r) => `<repo name="${escapeXml(r.name)}">${escapeXml(r.path)}</repo>`)
    .join("\n")

  return `<gitnexus_graph source="gitnexus" version="1" freshness="${freshness}">
<summary>${escapeXml(freshnessSummary(freshness))}</summary>
<indexed_repos>
${repoLines}
</indexed_repos>
<preferred_tools>
Use these MCP tools for structural code questions (faster than grep for call chains, dependencies, blast radius):
  gitnexus_query(query="...", repo="${escapeXml(primary)}")    - execution flows and concepts
  gitnexus_context(name="...", repo="${escapeXml(primary)}")   - callers, callees, processes
  gitnexus_impact(target="...", direction="upstream", repo="${escapeXml(primary)}") - blast radius
If MCP tools are not available to the current agent, fall back to bash:
  npx gitnexus query --repo ${escapeXml(primary)} "search terms"
  npx gitnexus context --repo ${escapeXml(primary)} "SymbolName"
  npx gitnexus impact --repo ${escapeXml(primary)} "SymbolName"
</preferred_tools>
<when_to_use>
Prefer graph over grep for: structural questions, call chains, execution flows, blast radius, dependency analysis.
Keep using grep/Read for: literal strings, config values, exact text patterns, file-level navigation.
</when_to_use>
<subagent_propagation>
To grant a spawned subagent graph access, include the marker ${OPT_IN_MARKER} anywhere in their prompt text.
The plugin will inject the same envelope into the subagent and strip the marker automatically.
Do not propagate graph access to subagents that do not touch code (librarian, plan critics, documentation writers).
</subagent_propagation>
</gitnexus_graph>`
}

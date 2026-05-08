/**
 * Tracks which session IDs are SUBAGENT (spawned child) sessions, identified by
 * the presence of `parentID` on `event(session.created)`. The public API still
 * answers `isMain(sessionID)` — internally that is `!subagentSessions.has(id)`.
 *
 * Why we track subagents (positive identification) and treat unknown sessions
 * as MAIN by default:
 *
 *   - `parentID` is the only reliable subagent signal: OpenCode sets it at
 *     spawn time; main sessions never have one.
 *   - The previous design tracked main sessions positively. After plugin
 *     reload or session compaction the in-memory set is empty and a real main
 *     session looks "unknown" — and was being misclassified as a subagent.
 *     That is the worst direction to fail in: the subagent-lite addendum omits
 *     the OPT_IN_MARKER propagation rules, so the orchestrator silently fails
 *     to grant graph access to spawned code agents.
 *   - Misclassifying an unknown subagent as main is the safer failure mode:
 *     it adds extra (harmless) text to the system prompt; the user-message
 *     envelope is still gated by the OPT_IN_MARKER check in
 *     `messages.transform`, so an unmarked subagent does NOT receive the
 *     envelope just because it was misclassified here.
 *
 * The `index.ts` entrypoint hydrates this registry on plugin init by replaying
 * `client.session.list()` so long-lived subagents survive a plugin reload.
 *
 * Source of truth for newly-created sessions: the `event(session.created)`
 * hook in `src/index.ts`.
 *
 * Each call to `createSessionRegistry()` returns its own isolated Set, so two
 * plugin instances in the same node process do not share state.
 */

export interface SessionRegistry {
  trackCreated(info: { id: string; parentID?: string }): void
  trackDeleted(info: { id: string }): void
  isMain(sessionID: string): boolean
  /** Test helper: clear every tracked session. */
  reset(): void
}

export function createSessionRegistry(): SessionRegistry {
  const subagentSessions = new Set<string>()

  return {
    trackCreated(info) {
      if (info.parentID) subagentSessions.add(info.id)
    },
    trackDeleted(info) {
      subagentSessions.delete(info.id)
    },
    isMain(sessionID) {
      return !subagentSessions.has(sessionID)
    },
    reset() {
      subagentSessions.clear()
    },
  }
}

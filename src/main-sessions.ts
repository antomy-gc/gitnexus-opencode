/**
 * Tracks which session IDs are "main" (top-level / user-driven) sessions, as
 * opposed to subagent / spawned child sessions. Used by the messages.transform
 * hook to decide whether a session is automatically eligible to receive the
 * graph hint envelope.
 *
 * Source of truth: the `event(session.created)` hook in src/index.ts. If the
 * session info has no `parentID`, it is a main session and is added here.
 * Subagent sessions (those with `parentID` set) are deliberately ignored — the
 * orchestrator must opt them in explicitly via the OPT_IN_MARKER instead.
 *
 * Each call to createMainSessionRegistry() returns its own isolated Set, so
 * two plugin instances in the same node process do not share state.
 */

export interface MainSessionRegistry {
  trackCreated(info: { id: string; parentID?: string }): void
  trackDeleted(info: { id: string }): void
  isMain(sessionID: string): boolean
  /** Test helper: clear every tracked session. */
  reset(): void
}

export function createMainSessionRegistry(): MainSessionRegistry {
  const mainSessions = new Set<string>()

  return {
    trackCreated(info) {
      if (info.parentID) return
      mainSessions.add(info.id)
    },
    trackDeleted(info) {
      mainSessions.delete(info.id)
    },
    isMain(sessionID) {
      return mainSessions.has(sessionID)
    },
    reset() {
      mainSessions.clear()
    },
  }
}

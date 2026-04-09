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
 */

const mainSessions = new Set<string>()

export function trackSessionCreated(info: { id: string; parentID?: string }): void {
  if (info.parentID) return
  mainSessions.add(info.id)
}

export function trackSessionDeleted(info: { id: string }): void {
  mainSessions.delete(info.id)
}

export function isMainSession(sessionID: string): boolean {
  return mainSessions.has(sessionID)
}

/** Test helper: clears the entire main-session set. Not for production use. */
export function __resetMainSessions(): void {
  mainSessions.clear()
}

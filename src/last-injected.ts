/**
 * Per-session memory of the most recent envelope that was actually injected.
 * Used by the messages.transform hook to deduplicate byte-identical envelopes:
 * if the cache.envelope for the next turn equals the value we last injected
 * for this session, we skip injection entirely. The agent already has the
 * envelope in its history; re-injecting it would only burn uncached input
 * tokens for zero new information.
 *
 * Lifecycle:
 *   - First turn of a session       -> get() returns undefined  -> inject + set()
 *   - Stable repo state next turn   -> get() == cache.envelope  -> SKIP, save tokens
 *   - Freshness flips (e.g. refreshing) -> get() != cache.envelope -> inject + set()
 *   - Compaction wipes history      -> handler calls clear()    -> next turn re-injects
 *   - Session deleted               -> registry calls clear()
 *
 * Each call to createLastInjectedRegistry() returns its own isolated Map so
 * two plugin instances loaded in the same node process do not share state,
 * matching the per-instance pattern used by hint-envelope and main-sessions.
 */

export interface LastInjectedRegistry {
  get(sessionID: string): string | undefined
  set(sessionID: string, envelope: string): void
  clear(sessionID: string): void
  reset(): void
}

export function createLastInjectedRegistry(): LastInjectedRegistry {
  const lastBySession = new Map<string, string>()

  return {
    get(sessionID) {
      return lastBySession.get(sessionID)
    },
    set(sessionID, envelope) {
      lastBySession.set(sessionID, envelope)
    },
    clear(sessionID) {
      lastBySession.delete(sessionID)
    },
    reset() {
      lastBySession.clear()
    },
  }
}

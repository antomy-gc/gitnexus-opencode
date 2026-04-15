import type { RepoInfo } from "./discovery.js"
import { commitsBehind as commitsBehindDefault } from "./staleness.js"

export type CommitsBehindFn = (repoPath: string) => number

/**
 * Build the agent-facing context string describing graph status.
 * Accepts an optional commitsBehindFn for testability.
 */
export function buildAgentContext(
  repos: RepoInfo[],
  commitsBehindFn: CommitsBehindFn = commitsBehindDefault,
): string | null {
  if (repos.length === 0) return null

  const indexed = repos.filter((r) => r.hasIndex)
  const unindexed = repos.filter((r) => !r.hasIndex)
  const stale = repos.filter((r) => r.hasIndex && r.isStale)

  const lines: string[] = ["[gitnexus] Graph status:"]

  if (indexed.length > 0) {
    const names = indexed.map((r) => {
      if (r.isStale) {
        const behind = commitsBehindFn(r.path)
        return `${r.name} (stale, ${behind} commits behind)`
      }
      return `${r.name} (up to date)`
    })
    lines.push(`Indexed: ${names.join(", ")}`)
  }

  if (unindexed.length > 0) {
    const names = unindexed.map((r) => r.name).join(", ")
    lines.push(`Not indexed: ${names}`)
  }

  if (stale.length > 0) {
    lines.push(`Auto-refreshing stale indexes in background.`)
  }

  return lines.join("\n")
}

/**
 * Build the user-facing toast message about repos needing attention.
 */
export function buildUserToast(repos: RepoInfo[]): string | null {
  if (repos.length === 0) return null

  const unindexed = repos.filter((r) => !r.hasIndex)
  const stale = repos.filter((r) => r.hasIndex && r.isStale)

  if (stale.length === 0 && unindexed.length === 0) return null

  const total = stale.length + unindexed.length
  const parts: string[] = []
  if (stale.length > 0) parts.push(`${stale.length} stale`)
  if (unindexed.length > 0) parts.push(`${unindexed.length} unindexed`)

  return `Knowledge graph: ${parts.join(", ")} repo${total > 1 ? "s" : ""}. Ask agent to index.`
}

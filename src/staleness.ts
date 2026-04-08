import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

interface MetaJson {
  lastCommit: string
  indexedAt: string
  repoPath: string
  stats?: Record<string, number>
}

/** Read .gitnexus/meta.json, returns null if missing or malformed */
export function readMeta(repoPath: string): MetaJson | null {
  const metaPath = join(repoPath, ".gitnexus", "meta.json")
  if (!existsSync(metaPath)) return null
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"))
  } catch {
    return null
  }
}

/** Get current HEAD commit SHA, returns empty string for non-git dirs */
function getHeadCommit(repoPath: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch {
    return ""
  }
}

/** Check if index exists */
export function hasIndex(repoPath: string): boolean {
  return existsSync(join(repoPath, ".gitnexus", "meta.json"))
}

/** Check if index is stale (HEAD moved since last analyze) */
export function isStale(repoPath: string): boolean {
  const meta = readMeta(repoPath)
  if (!meta) return false // no index = not stale, just missing
  const head = getHeadCommit(repoPath)
  if (!head) return false // non-git or error
  return head !== meta.lastCommit
}

/** Count commits behind HEAD */
export function commitsBehind(repoPath: string): number {
  const meta = readMeta(repoPath)
  if (!meta?.lastCommit) return 0
  try {
    const count = execSync(
      `git rev-list --count ${meta.lastCommit}..HEAD`,
      { cwd: repoPath, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim()
    return parseInt(count, 10) || 0
  } catch {
    return 0
  }
}

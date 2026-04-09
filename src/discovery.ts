import { readdirSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { basename, join } from "node:path"
import { hasIndex, isStale } from "./staleness.js"

export interface RepoInfo {
  name: string
  path: string
  hasIndex: boolean
  isStale: boolean
}

function isGitRepo(dirPath: string): boolean {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirPath,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    return root === dirPath
  } catch {
    return false
  }
}

/**
 * Scan a directory for git repositories (1 level deep).
 * Returns info about each discovered repo.
 */
export function discoverRepos(
  parentDir: string,
  onError?: (msg: string) => void,
): RepoInfo[] {
  const repos: RepoInfo[] = []

  // If parentDir itself is a git repo, return just it
  if (isGitRepo(parentDir)) {
    repos.push({
      name: basename(parentDir) || parentDir,
      path: parentDir,
      hasIndex: hasIndex(parentDir),
      isStale: isStale(parentDir),
    })
    return repos
  }

  let entries: string[]
  try {
    entries = readdirSync(parentDir)
  } catch (err) {
    onError?.(`Cannot read ${parentDir}: ${err instanceof Error ? err.message : String(err)}`)
    return repos
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const fullPath = join(parentDir, entry)
    try {
      if (!statSync(fullPath).isDirectory()) continue
    } catch {
      continue
    }
    if (isGitRepo(fullPath)) {
      repos.push({
        name: entry,
        path: fullPath,
        hasIndex: hasIndex(fullPath),
        isStale: isStale(fullPath),
      })
    }
  }

  return repos
}

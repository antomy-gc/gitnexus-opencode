import { readdirSync, existsSync, statSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"
import { hasIndex, isStale } from "./staleness.js"

export interface RepoInfo {
  name: string
  path: string
  hasIndex: boolean
  isStale: boolean
}

function isGitRepo(dirPath: string): boolean {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
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
export function discoverRepos(parentDir: string, depth: number = 1): RepoInfo[] {
  const repos: RepoInfo[] = []

  // If parentDir itself is a git repo, return just it
  if (isGitRepo(parentDir)) {
    repos.push({
      name: parentDir.split("/").pop() || parentDir,
      path: parentDir,
      hasIndex: hasIndex(parentDir),
      isStale: isStale(parentDir),
    })
    return repos
  }

  if (depth < 1) return repos

  let entries: string[]
  try {
    entries = readdirSync(parentDir)
  } catch {
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

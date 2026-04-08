import { execSync, spawn } from "child_process"
import { existsSync } from "fs"
import { join } from "path"
import { loadConfig, gitnexusCmd, type PluginConfig } from "./config.js"
import { hasIndex, isStale, commitsBehind, readMeta } from "./staleness.js"
import { discoverRepos, type RepoInfo } from "./discovery.js"

const GIT_MUTATION_RE = /git\s+(commit|merge|rebase|pull|cherry-pick|checkout|reset)/

const GRAPH_HINT = `
[gitnexus] Code knowledge graph available. Use gitnexus_query/context/impact
instead of explore agents for structure/flows/dependencies.
Use grep only for: comments, config files, runtime behavior.`

const INIT_PREREQUISITE = `
[gitnexus:prerequisite]
Before starting exploration, run the gitnexus analyze command to build the code knowledge graph.
This takes 30-120s (0 tokens) but provides all functional areas, execution flows,
symbol density, and callers/callees — saving ~80% of exploration tokens.
After analyze completes, use gitnexus_query/context/cypher instead of spawning
explore agents for codebase understanding.
Only spawn explore agents for: conventions, anti-patterns, CI/build.`

const SUBAGENT_HINT = `
[gitnexus] Code knowledge graph is indexed for this repo.
Before grepping for structure/flows/dependencies, try:
  gitnexus_query({query}) — find code by concept
  gitnexus_context({name}) — callers/callees/flows
  gitnexus_impact({target, direction: "upstream"}) — blast radius
Use grep only for: comments, config files, runtime behavior.`

function analyzeInBackground(
  repoPath: string,
  config: PluginConfig,
  log: (msg: string) => void
) {
  const cmd = gitnexusCmd(config)
  const child = spawn(cmd[0], [...cmd.slice(1), "analyze", repoPath], {
    stdio: "ignore",
    detached: true,
    cwd: repoPath,
  })
  child.unref()
  log(`Refreshing index for ${repoPath.split("/").pop()}...`)
}

function formatSessionMessage(
  cwd: string,
  repos: RepoInfo[],
  config: PluginConfig
): string | null {
  if (repos.length === 0) return null

  // Single repo (we're inside a git repo)
  if (repos.length === 1 && repos[0].path === cwd) {
    const repo = repos[0]
    const cmd = [...gitnexusCmd(config), "analyze"].join(" ")
    if (!repo.hasIndex) {
      return `[gitnexus] No code graph found for this repo. Ask the user if they want to build it. If yes, run: ${cmd} (takes 30-120s). Do NOT run without asking.`
    }
    if (repo.isStale && config.autoRefreshStale) {
      return null // silently refreshing in background
    }
    if (repo.isStale) {
      const behind = commitsBehind(repo.path)
      return `[gitnexus] Index is ${behind} commits behind HEAD. Ask the user if they want to refresh it. If yes, run: ${cmd} (takes 30-120s). Do NOT run without asking.`
    }
    return null
  }

  // Multiple repos (parent directory)
  const unindexed = repos.filter((r) => !r.hasIndex)
  const stale = repos.filter((r) => r.hasIndex && r.isStale)

  const parts: string[] = []
  const cmd = [...gitnexusCmd(config), "analyze"].join(" ")
  if (unindexed.length > 0) {
    const names = unindexed.map((r) => r.name).join(", ")
    parts.push(
      `[gitnexus] Found ${repos.length} repos, ${unindexed.length} without index: ${names}. Ask the user which ones to index. For each, run: ${cmd} <repo-path> (takes 30-120s per repo). Do NOT run without asking.`
    )
  }
  if (stale.length > 0 && !config.autoRefreshStale) {
    const names = stale.map((r) => r.name).join(", ")
    parts.push(`[gitnexus] Stale indexes: ${names}. Ask the user if they want to refresh. If yes, run: ${cmd} <repo-path> for each. Do NOT run without asking.`)
  }

  return parts.length > 0 ? parts.join("\n") : null
}

export interface HookHandlers {
  onSessionCreated: () => void
  onToolExecuteAfter: (
    input: { tool: string; args: Record<string, unknown> },
    output: { result: string; args: Record<string, unknown> }
  ) => void
  onToolExecuteBefore: (
    input: { tool: string; args: Record<string, unknown> },
    output: { args: Record<string, unknown> }
  ) => void
}

function isMcpAvailable(config: PluginConfig): boolean {
  const cmd = gitnexusCmd(config)
  try {
    execSync([...cmd, "--version"].join(" "), {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return true
  } catch {
    return false
  }
}

export function createHooks(
  cwd: string,
  log: (msg: string) => void
): HookHandlers {
  const config = loadConfig(cwd)
  const headCache = new Map<string, string>()
  const refreshingRepos = new Set<string>()
  let disabled = false

  function checkAndRefreshIfStale() {
    if (!config.autoRefreshStale) return
    const repos = discoverRepos(cwd, config.scanDepth)

    for (const repo of repos) {
      if (!repo.hasIndex || refreshingRepos.has(repo.path)) continue

      const meta = readMeta(repo.path)
      if (!meta?.lastCommit) continue

      let currentHead = headCache.get(repo.path)
      if (!currentHead) {
        try {
          currentHead = execSync("git rev-parse HEAD", {
            cwd: repo.path,
            encoding: "utf-8",
            timeout: 3000,
            stdio: ["pipe", "pipe", "pipe"],
          }).trim()
        } catch {
          continue
        }
        headCache.set(repo.path, currentHead)
      }

      if (currentHead !== meta.lastCommit) {
        refreshingRepos.add(repo.path)
        analyzeInBackground(repo.path, config, (msg) => {
          refreshingRepos.delete(repo.path)
          headCache.delete(repo.path) // reset cache after refresh
          log(msg)
        })
      }
    }
  }

  return {
    onSessionCreated() {
      if (!isMcpAvailable(config)) {
        const cmd = gitnexusCmd(config).join(" ")
        log(`[gitnexus] CLI not available (tried: ${cmd} --version). Plugin disabled for this session.`)
        disabled = true
        return
      }

      const repos = discoverRepos(cwd, config.scanDepth)

      if (config.autoRefreshStale) {
        for (const repo of repos) {
          if (repo.hasIndex && repo.isStale) {
            analyzeInBackground(repo.path, config, log)
          }
        }
      }

      const message = formatSessionMessage(cwd, repos, config)
      if (message) log(message)
    },

    onToolExecuteAfter(input, output) {
      if (disabled) return
      if (input.tool === "skill") {
        const name = input.args?.name as string | undefined
        if (!name) return

        const isInitSkill = name === "init-deep" || name === "init"
        if (isInitSkill) {
          output.result += INIT_PREREQUISITE
          return
        }

        // Light hint for any other skill
        const cwd = process.cwd()
        const anyIndexed =
          existsSync(join(cwd, ".gitnexus", "meta.json")) ||
          discoverRepos(cwd, 1).some((r) => r.hasIndex)
        if (anyIndexed) {
          output.result += GRAPH_HINT
        }
        return
      }

      // Post-commit staleness refresh
      if (input.tool === "bash" && config.autoRefreshOnCommit) {
        const cmd = input.args?.command as string | undefined
        if (!cmd || !GIT_MUTATION_RE.test(cmd)) return

        const repoPath = findGitRoot(cwd)
        if (repoPath && hasIndex(repoPath)) {
          analyzeInBackground(repoPath, config, log)
        }
      }
    },

    onToolExecuteBefore(input, output) {
      if (disabled) return
      if (input.tool !== "task") return
      const prompt = output.args.prompt as string | undefined
      if (!prompt || prompt.includes("[gitnexus]")) return

      const anyIndexed =
        existsSync(join(cwd, ".gitnexus", "meta.json")) ||
        discoverRepos(cwd, 1).some((r) => r.hasIndex)
      if (!anyIndexed) return

      checkAndRefreshIfStale()
      output.args.prompt = prompt + SUBAGENT_HINT
    },
  }
}

function findGitRoot(from: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: from,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch {
    return null
  }
}

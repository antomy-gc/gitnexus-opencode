import { execSync, spawn } from "child_process"
import { existsSync } from "fs"
import { join } from "path"
import { gitnexusCmd, type PluginConfig } from "./config.js"
import { hasIndex, readMeta } from "./staleness.js"
import { discoverRepos } from "./discovery.js"

const GIT_MUTATION_RE = /git\s+(commit|merge|rebase|pull|cherry-pick|checkout|reset)/

const GRAPH_HINT = `
[gitnexus] Code knowledge graph available. Use gitnexus_query/context/impact
instead of explore agents for structure/flows/dependencies.
Use grep only for: comments, config files, runtime behavior.`

const INIT_PREREQUISITE = `
[gitnexus:prerequisite]
Before starting exploration, run the gitnexus_analyze tool to build the code knowledge graph.
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

export function analyzeInBackground(
  repoPath: string,
  config: PluginConfig,
  onDone?: () => void
) {
  const cmd = gitnexusCmd(config)
  const child = spawn(cmd[0], [...cmd.slice(1), "analyze", repoPath], {
    stdio: "ignore",
    detached: true,
    cwd: repoPath,
  })
  child.unref()
  if (onDone) child.on("close", onDone)
}

export function createToolHooks(cwd: string, config: PluginConfig, disabled: () => boolean) {
  const headCache = new Map<string, string>()
  const refreshingRepos = new Set<string>()

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
        analyzeInBackground(repo.path, config, () => {
          refreshingRepos.delete(repo.path)
          headCache.delete(repo.path)
        })
      }
    }
  }

  return {
    onToolExecuteAfter(
      input: { tool: string; args: Record<string, unknown> },
      output: { result: string; args: Record<string, unknown> }
    ) {
      if (disabled()) return

      if (input.tool === "skill") {
        const name = input.args?.name as string | undefined
        if (!name) return

        if (name === "init-deep" || name === "init") {
          output.result += INIT_PREREQUISITE
          return
        }

        const anyIndexed =
          existsSync(join(cwd, ".gitnexus", "meta.json")) ||
          discoverRepos(cwd, 1).some((r) => r.hasIndex)
        if (anyIndexed) {
          output.result += GRAPH_HINT
        }
        return
      }

      if (input.tool === "bash" && config.autoRefreshOnCommit) {
        const cmd = input.args?.command as string | undefined
        if (!cmd || !GIT_MUTATION_RE.test(cmd)) return

        const repoPath = findGitRoot(cwd)
        if (repoPath && hasIndex(repoPath)) {
          analyzeInBackground(repoPath, config)
        }
      }
    },

    onToolExecuteBefore(
      input: { tool: string; args: Record<string, unknown> },
      output: { args: Record<string, unknown> }
    ) {
      if (disabled()) return
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

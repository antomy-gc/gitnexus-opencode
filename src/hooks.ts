import { execFileSync, spawn } from "node:child_process"
import { closeSync, existsSync, openSync } from "fs"
import { join } from "path"
import { gitnexusCmd, type PluginConfig } from "./config.js"
import { hasIndex } from "./staleness.js"
import { discoverRepos, type RepoInfo } from "./discovery.js"

const GIT_MUTATION_RE = /git\s+(commit|merge|rebase|pull|cherry-pick|checkout|switch|reset)/

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

const TASK_TOOL_NAMES = new Set(["task", "Task", "call_omo_agent"])

let cachedHint = ""

export function refreshHint(scanRoot: string): void {
  const repos = discoverRepos(scanRoot)
  cachedHint = buildSubagentHintFromRepos(repos)
}

function buildSubagentHintFromRepos(repos: RepoInfo[]): string {
  const indexed = repos.filter((r) => r.hasIndex)
  if (indexed.length === 0) return ""

  const repoNames = indexed.map((r) => r.name)
  const repo = repoNames[0]
  const repoLine = repoNames.length > 1 ? `Indexed repos: ${repoNames.join(", ")}.\n` : ""

  return `
[gitnexus] Code knowledge graph is indexed.${repoLine ? " " + repoLine.trim() : ""}
For call chains, dependencies, blast radius, or execution flows:
  gitnexus_query(query="...", repo="${repo}") — execution flows by concept
  gitnexus_context(name="...", repo="${repo}") — callers, callees, processes
  gitnexus_impact(target="...", direction="upstream", repo="${repo}") — blast radius
If MCP tools unavailable, same via bash:
  npx gitnexus query --repo ${repo} "search terms"
  npx gitnexus context --repo ${repo} "SymbolName"
  npx gitnexus impact --repo ${repo} "SymbolName"
Graph is faster than grep for structural queries (1 call replaces 3-5 grep/read chains).
Grep is better for: literal strings, config values, code patterns.
Skip graph if your task is pure reasoning/review without code discovery.`
}

export function analyzeInBackground(
  repoPath: string,
  config: PluginConfig,
  onDone?: () => void
) {
  const cmd = gitnexusCmd(config)
  const devNull = openSync("/dev/null", "w")
  const child = spawn(cmd[0], [...cmd.slice(1), "analyze", repoPath], {
    stdio: ["ignore", devNull, devNull],
    detached: true,
    cwd: repoPath,
  })
  closeSync(devNull)
  child.unref()
  if (onDone) child.on("close", onDone)
}

export function createToolHooks(cwd: string, config: PluginConfig, disabled: () => boolean) {
  return {
    onToolExecuteAfter(
      input: { tool: string; args: any },
      output: { output: string }
    ) {
      if (disabled()) return

      if (input.tool === "skill") {
        const name = input.args?.name as string | undefined
        if (!name) return

        if (name === "init-deep" || name === "init") {
          output.output += INIT_PREREQUISITE
          return
        }

        const anyIndexed =
          existsSync(join(cwd, ".gitnexus", "meta.json")) ||
          discoverRepos(cwd).some((r) => r.hasIndex)
        if (anyIndexed) {
          output.output += GRAPH_HINT
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
      input: { tool: string },
      output: { args: any }
    ) {
      if (disabled()) return
      if (!TASK_TOOL_NAMES.has(input.tool)) return

      const prompt = output.args.prompt as string | undefined
      if (!prompt || prompt.includes("[gitnexus]")) return

      if (!cachedHint) return

      output.args.prompt = prompt + cachedHint
    },
  }
}

function findGitRoot(from: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: from,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch {
    return null
  }
}

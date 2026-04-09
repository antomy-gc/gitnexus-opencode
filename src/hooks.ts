import { execFileSync, spawn } from "node:child_process"
import { closeSync, existsSync, openSync } from "fs"
import { join } from "path"
import { gitnexusCmd, type PluginConfig } from "./config.js"
import { hasIndex } from "./staleness.js"
import { discoverRepos } from "./discovery.js"
import {
  markRefreshing,
  markRefreshDone,
  refreshHintCache,
  getHintCache as getHintCacheDefault,
  scrubPromptGitnexusBlocks,
  stripOptInMarker,
  OPT_IN_MARKER,
  type HintCacheState,
} from "./hint-envelope.js"
import { isMainSession as isMainSessionDefault } from "./main-sessions.js"

const GIT_MUTATION_RE =
  /(?:^|[;&|]\s*)(?:\w+=\S+\s+)*git(?:\s+-C\s+\S+|\s+--\S+(?:=\S+)?)*\s+(commit|merge|rebase|pull|cherry-pick|switch|reset)\b/

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

const inFlight = new Set<string>()

/**
 * Schedule a background analyze for `repoPath`. The hint cache is rebuilt
 * twice:
 *   1. Before spawn — so the next messages.transform turn sees freshness="refreshing"
 *   2. In the close callback — so the cache transitions back to up_to_date
 *      (or may_be_stale if HEAD drifted again during analyze)
 *
 * `scanRoot` is the directory used for repo discovery when rebuilding the
 * cache. It is captured by closure into the spawn callbacks so the cache
 * always reflects the orchestrator's view of the workspace.
 */
export function scheduleAnalyze(
  repoPath: string,
  config: PluginConfig,
  scanRoot: string,
): boolean {
  if (inFlight.has(repoPath)) return false
  inFlight.add(repoPath)
  markRefreshing(repoPath)
  refreshHintCache(scanRoot)
  analyzeInBackground(repoPath, config, () => {
    inFlight.delete(repoPath)
    markRefreshDone(repoPath)
    refreshHintCache(scanRoot)
  })
  return true
}

function analyzeInBackground(
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
          scheduleAnalyze(repoPath, config, cwd)
        }
      }
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

/**
 * Pure factory for the experimental.chat.messages.transform hook body. Kept
 * out of index.ts so it can be unit-tested in isolation. The defaults wire
 * to the real main-session registry and hint-envelope cache; tests inject
 * fakes via the deps argument.
 */
export interface MessagesTransformDeps {
  isMain?: (sessionID: string) => boolean
  getCache?: () => HintCacheState
  log?: (message: string, level?: "debug" | "info" | "warn" | "error") => void
}

type TextPart = { type: "text"; text: string }
type MessageEntry = { info: { role: string; sessionID?: string }; parts: Array<{ type: string }> }

export function createMessagesTransformHandler(deps: MessagesTransformDeps = {}) {
  const isMain = deps.isMain ?? isMainSessionDefault
  const getCache = deps.getCache ?? getHintCacheDefault
  const log = deps.log ?? (() => {})

  return async function handle(
    _input: Record<string, never>,
    output: { messages: MessageEntry[] },
  ): Promise<void> {
    try {
      const lastUser = [...output.messages].reverse().find((m) => m.info.role === "user")
      if (!lastUser) return

      const textPart = lastUser.parts.find(
        (p) => p.type === "text" && typeof (p as { text?: unknown }).text === "string",
      ) as TextPart | undefined
      if (!textPart) return

      const sessionID = lastUser.info.sessionID
      if (!sessionID) return

      const originalText = textPart.text
      const hasMarker = originalText.includes(OPT_IN_MARKER)
      const main = isMain(sessionID)
      const eligible = main || hasMarker
      if (!eligible) return

      const cache = getCache()
      if (cache.freshness === "missing") return

      const scrubbed = scrubPromptGitnexusBlocks(originalText)
      const cleaned = hasMarker ? stripOptInMarker(scrubbed) : scrubbed

      textPart.text = `${cache.envelope}\n\n${cleaned}`

      log(
        "messages.transform injected: sessionID=" + sessionID +
          " main=" + main +
          " marker=" + hasMarker +
          " freshness=" + cache.freshness +
          ' textPreview="' + cleaned.slice(0, 60).replace(/\n/g, " ") + '"',
        "info",
      )
    } catch (err) {
      log(
        `messages.transform hook error: ${err instanceof Error ? err.message : String(err)}`,
        "warn",
      )
    }
  }
}

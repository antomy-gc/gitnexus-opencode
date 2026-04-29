import { execFileSync, spawn } from "node:child_process"
import { closeSync, existsSync, openSync } from "fs"
import { join } from "path"
import { gitnexusCmd, type PluginConfig } from "./config.js"
import { hasIndex } from "./staleness.js"
import { discoverRepos } from "./discovery.js"
import {
  scrubPromptGitnexusBlocks,
  stripOptInMarker,
  OPT_IN_MARKER,
  type HintCacheState,
  type HintEnvelopeState,
} from "./hint-envelope.js"
import type { LastInjectedRegistry } from "./last-injected.js"
import {
  STATIC_SYSTEM_ADDENDUM,
  STATIC_SYSTEM_ADDENDUM_SUBAGENT,
  systemAddendumPresent,
} from "./system-addendum.js"

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

/**
 * Per-plugin-instance analyze state: the set of repos that currently have a
 * background analyze in flight. Each call to createAnalyzeState() returns its
 * own isolated state, so two plugin instances do not share dedupe.
 */
export interface AnalyzeState {
  /** Returns false if a refresh is already in flight for this repo. */
  schedule(
    repoPath: string,
    config: PluginConfig,
    scanRoot: string,
    hintState: HintEnvelopeState,
  ): boolean
  /** Test helper: clear the in-flight set. */
  reset(): void
}

export function createAnalyzeState(): AnalyzeState {
  const inFlight = new Set<string>()

  return {
    schedule(repoPath, config, scanRoot, hintState) {
      if (inFlight.has(repoPath)) return false

      inFlight.add(repoPath)
      hintState.markRefreshing(repoPath)
      hintState.refreshHintCache(scanRoot)

      const cleanup = () => {
        inFlight.delete(repoPath)
        hintState.markRefreshDone(repoPath)
        hintState.refreshHintCache(scanRoot)
      }

      try {
        analyzeInBackground(repoPath, config, cleanup)
        return true
      } catch {
        // spawn() threw synchronously (e.g. openSync EACCES, invalid argv).
        // Without this cleanup the repo would be stuck in the `refreshing`
        // state and future schedule calls would short-circuit on inFlight.
        cleanup()
        return false
      }
    },
    reset() {
      inFlight.clear()
    },
  }
}

function analyzeInBackground(
  repoPath: string,
  config: PluginConfig,
  onDone: () => void,
) {
  const cmd = gitnexusCmd(config)
  const devNull = openSync("/dev/null", "w")
  let child
  try {
    child = spawn(cmd[0], [...cmd.slice(1), "analyze", repoPath], {
      stdio: ["ignore", devNull, devNull],
      detached: true,
      cwd: repoPath,
    })
  } finally {
    closeSync(devNull)
  }
  child.unref()
  // `close` fires for both clean exits and spawn-level failures (e.g. ENOENT
  // still emits close with code -2). `error` fires when the OS cannot start
  // the process at all; without a listener Node turns it into an uncaught
  // exception that would crash the plugin host. Both paths funnel into the
  // same cleanup so the refreshing state cannot leak.
  let settled = false
  const settleOnce = () => {
    if (settled) return
    settled = true
    onDone()
  }
  child.on("close", settleOnce)
  child.on("error", settleOnce)
}

/**
 * Dependencies needed by the tool hooks. All per-plugin-instance state is
 * passed in explicitly; hooks.ts never touches module-level mutable state.
 */
export interface ToolHooksDeps {
  cwd: string
  config: PluginConfig
  disabled: () => boolean
  analyzeState: AnalyzeState
  hintState: HintEnvelopeState
}

export function createToolHooks(deps: ToolHooksDeps) {
  const { cwd, config, disabled, analyzeState, hintState } = deps
  return {
    onToolExecuteAfter(
      input: { tool: string; args: any },
      output: { output: string },
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

        // Prefer the explicit `-C <path>` target from the command so a git
        // mutation inside a specific child repo refreshes THAT repo, not the
        // workspace root. Falls back to resolving the git root of `cwd` for
        // commands that don't use `-C`.
        const explicit = extractGitDashCPath(cmd, cwd)
        const repoPath = explicit ?? findGitRoot(cwd)
        if (repoPath && hasIndex(repoPath)) {
          analyzeState.schedule(repoPath, config, cwd, hintState)
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
 * Best-effort extractor for the `git -C <path>` target. Returns null when
 * the command does not use `-C`, when the path cannot be parsed, or when the
 * extracted path is not itself an indexed/discoverable git repo.
 *
 * Handles: `git -C path commit`, `git -C /abs/path merge`, `GIT_DIR=x git -C path reset`.
 * Relative paths are resolved against `cwd`. Quoted paths ("path with spaces")
 * are accepted.
 */
export function extractGitDashCPath(cmd: string, cwd: string): string | null {
  // Match `git -C <arg>` where <arg> is either a quoted string or a run of
  // non-whitespace characters. Allow leading env assignments and chained
  // command separators (&&, ;, |).
  const m = cmd.match(/(?:^|[;&|]\s*)(?:\w+=\S+\s+)*git\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
  if (!m) return null
  const raw = m[1] ?? m[2] ?? m[3]
  if (!raw) return null
  const abs = raw.startsWith("/") ? raw : join(cwd, raw)
  // Only return if the target is actually a real git root. This guards
  // against typos and paths that look valid but aren't repos.
  try {
    const root = findGitRoot(abs)
    return root
  } catch {
    return null
  }
}

/**
 * Pure factory for the experimental.chat.messages.transform hook body. Kept
 * out of index.ts so it can be unit-tested in isolation. deps.isMain and
 * deps.getCache are required — there are no module-level defaults anymore.
 */
export interface MessagesTransformDeps {
  isMain: (sessionID: string) => boolean
  getCache: () => HintCacheState
  /**
   * Optional per-session dedup registry. When supplied, the handler skips
   * injection on turns whose cache.envelope is byte-identical to the last
   * value already injected into this session. Omit to fall back to the
   * pre-dedup behavior (inject on every eligible turn).
   */
  lastInjected?: LastInjectedRegistry
  log?: (message: string, level?: "debug" | "info" | "warn" | "error") => void
}

type TextPart = { type: "text"; text: string }
type MessageEntry = { info: { role: string; sessionID?: string }; parts: Array<{ type: string }> }

/**
 * Detects whether ANY user message in the visible history still carries a
 * <gitnexus_graph> envelope. Used by the dedup path to recognize compaction:
 * if the conversation was rewritten and our previous envelope vanished, the
 * memoized "last injected" value is meaningless and must be cleared.
 */
function historyHasEnvelope(messages: MessageEntry[]): boolean {
  for (const m of messages) {
    if (m.info.role !== "user") continue
    for (const p of m.parts) {
      const text = (p as { text?: unknown }).text
      if (typeof text === "string" && text.includes("<gitnexus_graph")) {
        return true
      }
    }
  }
  return false
}

export function createMessagesTransformHandler(deps: MessagesTransformDeps) {
  const { isMain, getCache, lastInjected } = deps
  const log = deps.log ?? (() => {})

  return async function handle(
    _input: Record<string, never>,
    output: { messages: MessageEntry[] },
  ): Promise<void> {
    try {
      if (output.messages.length === 0) return
      // Only inject when the LAST message is the current user prompt. This
      // guards against mutating a historical user message during internal
      // follow-up LLM calls where the tail is not a user turn.
      const last = output.messages[output.messages.length - 1]!
      if (last.info.role !== "user") return

      const textPart = last.parts.find(
        (p) => p.type === "text" && typeof (p as { text?: unknown }).text === "string",
      ) as TextPart | undefined
      if (!textPart) return

      const sessionID = last.info.sessionID
      if (!sessionID) return

      const originalText = textPart.text

      // Scrub any leading stale envelope BEFORE checking for the marker, so a
      // previously-injected envelope (which contains the OPT_IN_MARKER literal
      // inside its <subagent_propagation> section) cannot masquerade as a fresh
      // opt-in after compaction or rehydration. The marker detection must see
      // only what the orchestrator wrote, not the plugin's own previous output.
      const scrubbed = scrubPromptGitnexusBlocks(originalText)
      const hasMarker = scrubbed.includes(OPT_IN_MARKER)
      const main = isMain(sessionID)
      const eligible = main || hasMarker
      if (!eligible) return

      const cache = getCache()
      if (cache.freshness === "missing") return

      const cleaned = hasMarker ? stripOptInMarker(scrubbed) : scrubbed

      // Compaction guard: if no <gitnexus_graph> block survives in the full
      // history of user messages, the conversation was compacted and the
      // agent has lost the envelope. Drop our memoized "last injected" so
      // the next equality check forces a fresh injection on this turn.
      if (lastInjected && !historyHasEnvelope(output.messages)) {
        lastInjected.clear(sessionID)
      }

      // Dedup: byte-identical envelope already in history -> skip injection.
      // The agent already sees this exact envelope from a previous turn; the
      // only difference would be uncached input tokens with zero new info.
      const previous = lastInjected?.get(sessionID)
      if (previous !== undefined && previous === cache.envelope) {
        log(
          "messages.transform skipped (dedup hit): sessionID=" + sessionID +
            " main=" + main +
            " marker=" + hasMarker +
            " freshness=" + cache.freshness,
          "info",
        )
        // Marker still has to be stripped even when we skip injection,
        // otherwise the orchestrator's literal [[gitnexus:graph]] would
        // leak into the subagent prompt.
        if (hasMarker) textPart.text = cleaned
        return
      }

      textPart.text = `${cache.envelope}\n\n${cleaned}`
      lastInjected?.set(sessionID, cache.envelope)

      log(
        "messages.transform injected: sessionID=" + sessionID +
          " main=" + main +
          " marker=" + hasMarker +
          " freshness=" + cache.freshness +
          " dedup=" + (previous === undefined ? "first" : "changed") +
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

export interface SystemTransformDeps {
  disabled: () => boolean
  isMain: (sessionID: string) => boolean
  log?: (message: string, level?: "debug" | "info" | "warn" | "error") => void
}

export function createSystemTransformHandler(deps: SystemTransformDeps) {
  const { disabled, isMain } = deps
  const log = deps.log ?? (() => {})

  return async function handle(
    input: { sessionID?: string; model?: unknown },
    output: { system: string[] },
  ): Promise<void> {
    try {
      if (disabled()) return
      if (systemAddendumPresent(output.system)) return
      const sessionIsKnownSubagent =
        !!input.sessionID && !isMain(input.sessionID)
      const addendum = sessionIsKnownSubagent
        ? STATIC_SYSTEM_ADDENDUM_SUBAGENT
        : STATIC_SYSTEM_ADDENDUM
      const isMainSession = !sessionIsKnownSubagent
      output.system.push(addendum)
      log(
        `system.transform pushed gitnexus addendum (variant=${isMainSession ? "full" : "subagent-lite"} sessionID=${input.sessionID ?? "<none>"})`,
        "info",
      )
    } catch (err) {
      log(
        `system.transform hook error: ${err instanceof Error ? err.message : String(err)}`,
        "warn",
      )
    }
  }
}

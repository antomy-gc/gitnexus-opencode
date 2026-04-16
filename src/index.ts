import { execFileSync } from "node:child_process"
import { tool, type Plugin } from "@opencode-ai/plugin"
import { loadConfig, gitnexusCmd } from "./config.js"
import { discoverRepos } from "./discovery.js"
import { buildUserToast } from "./context.js"
import {
  createToolHooks,
  createMessagesTransformHandler,
  createSystemTransformHandler,
  createAnalyzeState,
} from "./hooks.js"
import { createHintEnvelopeState } from "./hint-envelope.js"
import { createMainSessionRegistry } from "./main-sessions.js"


const TOAST_DELAY_MS = 6000 // heuristic: waits past oh-my-openagent spinner animation

function isGitNexusCliAvailable(config: ReturnType<typeof loadConfig>): boolean {
  const cmd = gitnexusCmd(config)
  try {
    execFileSync(cmd[0], [...cmd.slice(1), "--version"], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return true
  } catch {
    return false
  }
}

const plugin: Plugin = async ({ directory, worktree, client }) => {
  const scanRoot = worktree ?? directory
  const config = loadConfig(scanRoot)
  let disabled = false

  const log = (message: string, level: "debug" | "info" | "warn" | "error" = "info") => {
    void client.app.log({ body: { service: "gitnexus", level, message } })
  }

  // Instance-scoped state. Each plugin(...) call — i.e. each workspace /
  // worktree OpenCode loads — gets its own caches and registries so two
  // workspaces running in the same node process cannot overwrite each
  // other's envelopes, refresh state, or main-session sets.
  const hintState = createHintEnvelopeState()
  const mainSessions = createMainSessionRegistry()
  const analyzeState = createAnalyzeState()

  const toolHooks = createToolHooks({
    cwd: scanRoot,
    config,
    disabled: () => disabled,
    analyzeState,
    hintState,
  })

  const messagesTransformHandler = createMessagesTransformHandler({
    isMain: (sessionID) => mainSessions.isMain(sessionID),
    getCache: () => hintState.getHintCache(),
    log,
  })

  const systemTransformHandler = createSystemTransformHandler({
    disabled: () => disabled,
    isMain: (sessionID) => mainSessions.isMain(sessionID),
    log,
  })

  const cmd = gitnexusCmd(config)

  const tools = {
    gitnexus_analyze: tool({
      description:
        "Build or refresh the GitNexus code knowledge graph for a repository. " +
        "Expensive (30-120s). Intended for the main agent; not delegated to subagents.",
      args: {
        path: tool.schema.string().optional().describe("Path to the git repository. Defaults to current directory."),
      },
      async execute(args) {
        const repoPath = args.path || scanRoot
        try {
          const result = execFileSync(
            cmd[0],
            [...cmd.slice(1), "analyze", repoPath],
            { encoding: "utf-8", timeout: 300000, cwd: repoPath }
          )
          return `Graph built successfully for ${repoPath}.\n${result}`
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Failed to build graph: ${msg}`
        }
      },
    }),
  }

  return {
    tool: tools,

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const info = (event.properties as { info?: { id?: string } } | undefined)?.info
        if (info?.id) mainSessions.trackDeleted({ id: info.id })
        return
      }

      if (event.type !== "session.created") return

      try {
        const info = (event.properties as { info?: { id?: string; parentID?: string } } | undefined)?.info
        const sessionID = info?.id
        if (info?.id) mainSessions.trackCreated({ id: info.id, parentID: info.parentID })

        if (!isGitNexusCliAvailable(config)) {
          const cmdStr = gitnexusCmd(config).join(" ")
          log(`CLI not available (${cmdStr} --version failed). Plugin disabled for this session.`, "warn")
          disabled = true
          return
        }

        const repos = discoverRepos(scanRoot, (msg) => log(msg, "warn"))
        hintState.refreshHintCache(scanRoot)
        log(`Discovered ${repos.length} repo(s): ${repos.map((r) => r.name).join(", ") || "none"}`)

        if (config.autoRefreshStale) {
          for (const repo of repos) {
            if (repo.hasIndex && repo.isStale) {
              analyzeState.schedule(repo.path, config, scanRoot, hintState)
            }
          }
        }

        if (sessionID) {
          log(`Session ${sessionID} ready; envelope will be injected via messages.transform when eligible`)
        }

        const toastMessage = buildUserToast(repos)
        if (toastMessage) {
          // Delay toast so it appears after oh-my-openagent's 5s spinner animation
          setTimeout(() => {
            client.tui.showToast({
              body: {
                title: "GitNexus",
                message: toastMessage,
                variant: "info",
                duration: 5000,
              },
            }).catch(() => {})
          }, TOAST_DELAY_MS)
        }
      } catch (err) {
        log(`session.created handler error: ${err instanceof Error ? err.message : String(err)}`, "error")
      }
    },

    "tool.execute.after": async (input, output) => {
      toolHooks.onToolExecuteAfter(input, output)
    },

    "experimental.chat.messages.transform": async (input, output) => {
      if (disabled) return
      await messagesTransformHandler(input, output)
    },

    "experimental.chat.system.transform": async (input, output) => {
      await systemTransformHandler(input, output)
    },
  }
}

export default plugin

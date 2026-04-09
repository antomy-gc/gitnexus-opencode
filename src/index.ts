import { execFileSync } from "node:child_process"
import { tool, type Plugin } from "@opencode-ai/plugin"
import { loadConfig, gitnexusCmd } from "./config.js"
import { discoverRepos } from "./discovery.js"
import { buildAgentContext, buildUserToast } from "./context.js"
import { createToolHooks, refreshHint, scheduleAnalyze } from "./hooks.js"


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

  const toolHooks = createToolHooks(scanRoot, config, () => disabled)

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
      if (event.type !== "session.created") return

      try {
        const sessionID = (event.properties as { info?: { id?: string } } | undefined)?.info?.id

        if (!isGitNexusCliAvailable(config)) {
          const cmdStr = gitnexusCmd(config).join(" ")
          log(`CLI not available (${cmdStr} --version failed). Plugin disabled for this session.`, "warn")
          disabled = true
          return
        }

        const repos = discoverRepos(scanRoot, (msg) => log(msg, "warn"))
        refreshHint(scanRoot)
        log(`Discovered ${repos.length} repo(s): ${repos.map((r) => r.name).join(", ") || "none"}`)

        if (config.autoRefreshStale) {
          for (const repo of repos) {
            if (repo.hasIndex && repo.isStale) {
              scheduleAnalyze(repo.path, config, () => refreshHint(scanRoot))
            }
          }
        }

        if (sessionID) {
          const agentContext = buildAgentContext(repos)
          if (agentContext) {
            const promptArgs = {
              path: { id: sessionID },
              body: {
                noReply: true as const,
                parts: [{ type: "text" as const, text: agentContext }],
              },
              query: { directory: scanRoot },
            }
            try {
              if (typeof client.session.promptAsync === "function") {
                await client.session.promptAsync(promptArgs)
              } else {
                await client.session.prompt(promptArgs)
              }
              log(`Agent context injected for session ${sessionID}`)
            } catch (err) {
              log(`session.prompt failed: ${err instanceof Error ? err.message : String(err)}`, "warn")
            }
          }
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

    "tool.execute.before": async (input, output) => {
      toolHooks.onToolExecuteBefore(input, output)
    },
  }
}

export default plugin

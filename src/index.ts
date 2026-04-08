import { execSync } from "child_process"
import { tool } from "@opencode-ai/plugin"
import { loadConfig, gitnexusCmd } from "./config.js"
import { discoverRepos, type RepoInfo } from "./discovery.js"
import { commitsBehind } from "./staleness.js"
import { analyzeInBackground, createToolHooks } from "./hooks.js"

interface SessionPromptBody {
  noReply: true
  parts: Array<{ type: "text"; text: string }>
}

interface ToastBody {
  title?: string
  message: string
  variant: "info" | "success" | "error" | "warning"
  duration?: number
}

interface PluginContext {
  directory: string
  $: (cmd: TemplateStringsArray, ...args: unknown[]) => Promise<unknown>
  client: {
    app: {
      log: (opts: { service: string; level: string; message: string }) => Promise<void>
    }
    session: {
      prompt: (opts: {
        path: { id: string }
        body: SessionPromptBody
        query?: { directory: string }
      }) => Promise<unknown>
      promptAsync?: (opts: {
        path: { id: string }
        body: SessionPromptBody
        query?: { directory: string }
      }) => Promise<unknown>
    }
    tui: {
      showToast: (opts: { body: ToastBody }) => Promise<unknown>
    }
  }
}

function isMcpAvailable(config: ReturnType<typeof loadConfig>): boolean {
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

function buildAgentContext(repos: RepoInfo[]): string | null {
  if (repos.length === 0) return null

  const indexed = repos.filter((r) => r.hasIndex)
  const unindexed = repos.filter((r) => !r.hasIndex)
  const stale = repos.filter((r) => r.hasIndex && r.isStale)

  const lines: string[] = ["[gitnexus] Graph status:"]

  if (indexed.length > 0) {
    const names = indexed.map((r) => {
      if (r.isStale) {
        const behind = commitsBehind(r.path)
        return `${r.name} (stale, ${behind} commits behind)`
      }
      return `${r.name} (up to date)`
    })
    lines.push(`Indexed: ${names.join(", ")}`)
  }

  if (unindexed.length > 0) {
    const names = unindexed.map((r) => r.name).join(", ")
    lines.push(`Not indexed: ${names}`)
  }

  if (stale.length > 0) {
    lines.push(`Auto-refreshing stale indexes in background.`)
  }

  return lines.join("\n")
}

function buildUserToast(repos: RepoInfo[]): string | null {
  if (repos.length === 0) return null

  const unindexed = repos.filter((r) => !r.hasIndex)
  const stale = repos.filter((r) => r.hasIndex && r.isStale)

  if (stale.length === 0 && unindexed.length === 0) return null

  const parts: string[] = []
  if (stale.length > 0) parts.push(`stale for ${stale.length}`)
  if (unindexed.length > 0) parts.push(`missing for ${unindexed.length}`)

  return `Knowledge graph is ${parts.join(" and ")} repo${stale.length + unindexed.length > 1 ? "s" : ""}. Ask agent to index.`
}

const plugin = async (ctx: PluginContext): Promise<Record<string, unknown>> => {
  const cwd = ctx.directory
  const config = loadConfig(cwd)
  let disabled = false

  const log = (message: string) => {
    ctx.client.app.log({ service: "gitnexus", level: "info", message })
  }

  const toolHooks = createToolHooks(cwd, config, () => disabled)

  const tools = {
    gitnexus_analyze: tool({
      description: "Build or refresh the GitNexus code knowledge graph for a repository. Takes 30-120s.",
      args: {
        path: tool.schema.string().optional().describe("Path to the git repository. Defaults to current directory."),
      },
      async execute(args) {
        const repoPath = args.path || cwd
        const cmd = gitnexusCmd(config)
        try {
          const result = execSync(
            [...cmd, "analyze", repoPath].join(" "),
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

    event: async ({ event }: { event: { type: string; properties: Record<string, any> } }) => {
      if (event.type !== "session.created") return

      try {
        const sessionID = event.properties?.info?.id as string | undefined

        if (!isMcpAvailable(config)) {
          const cmd = gitnexusCmd(config).join(" ")
          log(`CLI not available (${cmd} --version failed). Plugin disabled for this session.`)
          disabled = true
          return
        }

        const repos = discoverRepos(cwd, config.scanDepth)
        log(`Discovered ${repos.length} repo(s): ${repos.map((r) => r.name).join(", ") || "none"}`)

        if (config.autoRefreshStale) {
          for (const repo of repos) {
            if (repo.hasIndex && repo.isStale) {
              analyzeInBackground(repo.path, config)
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
              query: { directory: cwd },
            }
            try {
              if (typeof ctx.client.session.promptAsync === "function") {
                await ctx.client.session.promptAsync(promptArgs)
              } else {
                await ctx.client.session.prompt(promptArgs)
              }
              log(`Agent context injected for session ${sessionID}`)
            } catch (err) {
              log(`session.prompt failed: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        }

        const toastMessage = buildUserToast(repos)
        if (toastMessage) {
          // Delay toast so it appears after oh-my-openagent's 5s spinner animation
          setTimeout(() => {
            ctx.client.tui.showToast({
              body: {
                title: "GitNexus",
                message: toastMessage,
                variant: "info",
                duration: 5000,
              },
            }).catch(() => {})
          }, 6000)
        }
      } catch (err) {
        log(`session.created handler error: ${err instanceof Error ? err.message : String(err)}`)
      }
    },

    "tool.execute.after": async (
      input: { tool: string; args: Record<string, unknown> },
      output: { result: string; args: Record<string, unknown> }
    ) => {
      toolHooks.onToolExecuteAfter(input, output)
    },

    "tool.execute.before": async (
      input: { tool: string; args: Record<string, unknown> },
      output: { args: Record<string, unknown> }
    ) => {
      toolHooks.onToolExecuteBefore(input, output)
    },
  }
}

export default plugin

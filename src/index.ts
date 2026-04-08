import { createHooks } from "./hooks.js"

interface PluginContext {
  directory: string
  $: (cmd: TemplateStringsArray, ...args: unknown[]) => Promise<unknown>
  client: {
    app: {
      log: (opts: {
        service: string
        level: string
        message: string
      }) => Promise<void>
    }
  }
}

const plugin = async (ctx: PluginContext) => {
  const cwd = ctx.directory
  const log = (message: string) => {
    ctx.client.app.log({ service: "gitnexus", level: "info", message })
  }

  const hooks = createHooks(cwd, log)

  return {
    event: async ({ event }: { event: { type: string } }) => {
      if (event.type === "session.created") {
        hooks.onSessionCreated()
      }
    },

    "tool.execute.after": async (
      input: { tool: string; args: Record<string, unknown> },
      output: { result: string; args: Record<string, unknown> }
    ) => {
      hooks.onToolExecuteAfter(input, output)
    },

    "tool.execute.before": async (
      input: { tool: string; args: Record<string, unknown> },
      output: { args: Record<string, unknown> }
    ) => {
      hooks.onToolExecuteBefore(input, output)
    },
  }
}

export default plugin

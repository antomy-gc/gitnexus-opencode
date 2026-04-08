import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export interface PluginConfig {
  /** GitNexus npm package version. Use "latest" or pin like "1.5.2" */
  gitnexusVersion: string
  /** Automatically refresh stale indexes on session start */
  autoRefreshStale: boolean
  /** Automatically refresh after git mutations (commit, merge, etc.) */
  autoRefreshOnCommit: boolean

}

const DEFAULTS: PluginConfig = {
  gitnexusVersion: "1.5.2",
  autoRefreshStale: true,
  autoRefreshOnCommit: true,

}

const CONFIG_FILENAME = "gitnexus-opencode.json"

/**
 * Load config from project-level or global, with project overriding global.
 * Locations checked:
 *   .opencode/gitnexus-opencode.json  (project)
 *   ~/.config/opencode/gitnexus-opencode.json  (global)
 */
export function loadConfig(cwd: string): PluginConfig {
  const projectPath = join(cwd, ".opencode", CONFIG_FILENAME)
  const globalPath = join(homedir(), ".config", "opencode", CONFIG_FILENAME)

  let merged = { ...DEFAULTS }

  for (const cfgPath of [globalPath, projectPath]) {
    if (existsSync(cfgPath)) {
      try {
        const raw = JSON.parse(readFileSync(cfgPath, "utf-8"))
        merged = { ...merged, ...raw }
      } catch {
        // ignore malformed config
      }
    }
  }

  return merged
}

/** Build the npx command array for gitnexus CLI */
export function gitnexusCmd(config: PluginConfig): string[] {
  const pkg =
    config.gitnexusVersion === "latest"
      ? "gitnexus"
      : `gitnexus@${config.gitnexusVersion}`
  return ["npx", "-y", pkg]
}

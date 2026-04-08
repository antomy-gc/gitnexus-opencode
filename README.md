# gitnexus-opencode

OpenCode plugin for [GitNexus](https://github.com/nicepkg/gitnexus) — automatic code graph indexing, staleness detection, and AI agent hints.

**Status: alpha.** Core logic written, plugin loads in OpenCode, custom tool registers. Session start hooks (toast, context injection) have bugs being fixed.

## What it does

**On session start:**
- Verifies GitNexus CLI is reachable (disables plugin if not)
- Discovers git repos (current dir + subdirectories)
- Injects graph status into agent context via `session.prompt({ noReply: true })` (facts only, no instructions)
- Shows toast to the user: `Knowledge graph is stale for 1 and missing for 2 repos. Ask agent to index.`
- Background-refreshes stale indexes

**Custom tool:**

`gitnexus_analyze` — builds or refreshes the code knowledge graph. Registered via `@opencode-ai/plugin` SDK with `tool()` wrapper. Available to main agent and all subagents.

**Tool hooks:**

| Hook | Trigger | Action |
|------|---------|--------|
| `tool.execute.after` on `skill` | Skill loaded | Inject graph prerequisite for `init-deep`/`init`, light hint for others |
| `tool.execute.after` on `bash` | Git mutation detected | Background re-index |
| `tool.execute.before` on `task` | Subagent spawned | Check staleness (catches external commits), inject GitNexus MCP hint |

## Install (local development)

Build the plugin:
```bash
npm install && npm run build
```

Copy the bundled file to OpenCode plugins directory:
```bash
cp dist/gitnexus-opencode.js ~/.config/opencode/plugins/
```

Ensure GitNexus MCP is configured in `~/.config/opencode/config.json`:
```json
{
  "mcp": {
    "gitnexus": {
      "type": "local",
      "command": ["npx", "-y", "gitnexus@1.5.2", "mcp"]
    }
  }
}
```

Restart OpenCode.

## Configuration

Create `.opencode/gitnexus-opencode.json` (project) or `~/.config/opencode/gitnexus-opencode.json` (global):

```json
{
  "gitnexusVersion": "1.5.2",
  "autoRefreshStale": true,
  "autoRefreshOnCommit": true,
  "scanDepth": 1
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `gitnexusVersion` | `"1.5.2"` | Pin the gitnexus npm version |
| `autoRefreshStale` | `true` | Refresh stale indexes on session start and before subagent spawns |
| `autoRefreshOnCommit` | `true` | Refresh after git commit/merge/rebase |
| `scanDepth` | `1` | How deep to scan for repos in non-git directories |

## Build

```bash
npm run build    # tsc + esbuild bundle
```

Produces `dist/gitnexus-opencode.js` — single file (~12KB), all internal modules bundled, `@opencode-ai/plugin` as external (resolved from OpenCode runtime).

## Uninstall

Remove `~/.config/opencode/plugins/gitnexus-opencode.js` and restart OpenCode.

For full cleanup see [UNINSTALL.md](./UNINSTALL.md).

## How it works

The plugin uses OpenCode's native plugin API — no forks, no patches, no modifications to existing skills.

On session start it verifies the GitNexus CLI is reachable. If not, the plugin disables itself for that session. It discovers repos (including in parent directories), injects graph status as context for the agent, shows an actionable toast to the user, and refreshes stale indexes in background.

It registers a `gitnexus_analyze` custom tool via `@opencode-ai/plugin` SDK (uses `tool.schema` for Zod args, keeping the plugin dependency-free — zod comes from the SDK at runtime). During the session it injects lightweight hints (~150 tokens) into agent and subagent contexts. Before spawning subagents it checks for external commits and triggers background re-indexing if needed.

## License

MIT

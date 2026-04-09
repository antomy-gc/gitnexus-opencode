# gitnexus-opencode

OpenCode plugin for [GitNexus](https://github.com/nicepkg/gitnexus) — automatic code graph indexing, staleness detection, and AI agent hints.

## What it does

**On session start:**
- Verifies GitNexus CLI is reachable (disables plugin if not)
- Discovers git repos (current dir + subdirectories)
- Injects graph status into agent context via `session.promptAsync`
- Shows toast with graph status (delayed 6s to avoid oh-my-openagent spinner overlap)
- Background-refreshes stale indexes

**Tools:**

- `gitnexus_query`, `gitnexus_context`, `gitnexus_impact` — from GitNexus MCP server. Available to all agents including subagents (requires [permission setup](#allow-gitnexus-tools-for-subagents)).
- `gitnexus_analyze` — plugin tool for building/refreshing the graph. Intended for the main agent (re-indexing is expensive, ~30-120s). By default it is NOT delegated to subagents unless explicitly permitted in opencode.json.

**Tool hooks:**

| Hook | Trigger | Action |
|------|---------|--------|
| `tool.execute.after` on `skill` | Skill loaded | Inject graph prerequisite for `init-deep`/`init`, availability hint for others |
| `tool.execute.after` on `bash` | Git mutation detected | Background re-index |
| `tool.execute.before` on `task`/`call_omo_agent` | Subagent spawned | Inject GitNexus hint with MCP tools + CLI fallback |

**Subagent hints:**

The plugin injects an informational hint into subagent prompts. Category agents (deep, quick, oracle, etc.) use GitNexus MCP tools directly. Explore/librarian agents fall back to CLI via bash (`npx gitnexus query/context/impact`).

The hint is non-imperative — agents decide whether to use the graph based on their task.

## Install

Build and deploy:
```bash
npm install && npm run build
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

### Allow GitNexus tools for subagents

OpenCode's explore/librarian agents block non-built-in tools by default. Add permissions to `~/.config/opencode/opencode.json` so subagents can use GitNexus MCP tools directly:

```json
{
  "permission": {
    "gitnexus_query": "allow",
    "gitnexus_context": "allow",
    "gitnexus_impact": "allow"
  }
}
```

Without this, the plugin still works — subagents fall back to GitNexus CLI via bash (slower, ~3-5s overhead per call).

Restart OpenCode.

For full step-by-step installation guide (intended for AI agents), see [INSTALL.md](./INSTALL.md).

## Configuration

Create `.opencode/gitnexus-opencode.json` (project) or `~/.config/opencode/gitnexus-opencode.json` (global):

```json
{
  "gitnexusVersion": "1.5.2",
  "autoRefreshStale": true,
  "autoRefreshOnCommit": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `gitnexusVersion` | `"1.5.2"` | Pin the gitnexus npm version |
| `autoRefreshStale` | `true` | Refresh stale indexes on session start and before subagent spawns |
| `autoRefreshOnCommit` | `true` | Refresh after git commit/merge/rebase |

## Build

```bash
npm run build    # tsc + esbuild bundle
```

Produces `dist/gitnexus-opencode.js` — single file, all internal modules bundled, `@opencode-ai/plugin` as external (resolved from OpenCode runtime).

## Uninstall

Remove `~/.config/opencode/plugins/gitnexus-opencode.js` and restart OpenCode.

If you added GitNexus permissions to `opencode.json`, remove the `gitnexus_query`, `gitnexus_context`, `gitnexus_impact` entries from the `permission` object.

For full cleanup see [UNINSTALL.md](./UNINSTALL.md).

## License

MIT

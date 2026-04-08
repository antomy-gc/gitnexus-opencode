# gitnexus-opencode

OpenCode plugin for [GitNexus](https://github.com/nicepkg/gitnexus) — automatic code graph indexing, staleness detection, and AI agent hints.

## What it does

**On session start:**
- Verifies GitNexus CLI is reachable (disables plugin if not)
- Discovers git repos (current dir + subdirectories)
- Injects graph status into agent context (facts only, no instructions)
- Shows toast to the user: `Knowledge graph is stale for 1 and missing for 2 repos. Ask agent to index.`
- Background-refreshes stale indexes

**During the session:**

| Mechanism | Trigger | Action |
|-----------|---------|--------|
| `gitnexus_analyze` tool | Agent or user request | Build/refresh graph for a repo |
| `tool.execute.after` on `skill` | Skill loaded | Inject graph prerequisite for `init-deep`/`init`, light hint for others |
| `tool.execute.after` on `bash` | Git mutation detected | Background re-index |
| `tool.execute.before` on `task` | Subagent spawned | Check staleness (catches external commits), inject GitNexus MCP hint |

## Install

Give your OpenCode agent the [INSTALL.md](./INSTALL.md) file and ask it to follow the instructions. Or manually:

```json
// ~/.config/opencode/config.json
{
  "plugin": ["gitnexus-opencode"],
  "mcp": {
    "gitnexus": {
      "type": "local",
      "command": ["npx", "-y", "gitnexus@1.5.2", "mcp"]
    }
  }
}
```

Restart OpenCode. The plugin will show a toast if indexes are missing or stale.

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

## Uninstall

Give your OpenCode agent the [UNINSTALL.md](./UNINSTALL.md) file, or manually remove `"gitnexus-opencode"` from the `plugin` array in your config.

## How it works

The plugin uses OpenCode's native plugin API — no forks, no patches, no modifications to existing skills.

On session start it verifies the GitNexus CLI is reachable. If not, the plugin disables itself for that session. If available, it discovers repos (including in parent directories), injects graph status as context for the agent (facts only — no advice), shows an actionable toast to the user, and refreshes stale indexes in background.

It registers a `gitnexus_analyze` custom tool that the agent can call to build or refresh graphs on demand. During the session it injects lightweight hints (~150 tokens) into agent and subagent contexts so they know the code graph is available. Before spawning subagents it checks for external commits (e.g., made in a separate terminal) and triggers background re-indexing if needed.

## License

MIT

# gitnexus-opencode

OpenCode plugin for [GitNexus](https://github.com/nicepkg/gitnexus) — automatic code graph indexing, staleness detection, and AI agent hints.

## What it does

| Hook | Trigger | Action |
|------|---------|--------|
| `session.created` | Session starts | Verify GitNexus CLI is available (disable plugin if not), discover repos, background refresh if stale, prompt to build missing indexes |
| `tool.execute.after` on `skill` | Skill loaded | Inject graph prerequisite for `init-deep`/`init`, light hint for others |
| `tool.execute.after` on `bash` | Git mutation detected | Background re-index |
| `tool.execute.before` on `task` | Subagent spawned | Check staleness (catches external commits), inject GitNexus MCP usage hint into prompt |

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

Restart OpenCode. The plugin will detect missing indexes and offer to build them.

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

On session start it verifies the GitNexus CLI is reachable. If not, the plugin disables itself for that session and logs a message. If available, it discovers repos (including in parent directories), refreshes stale indexes in the background, and prompts the agent to build missing ones.

During the session it injects lightweight hints (~150 tokens) into agent and subagent contexts so they know the code graph is available. Before spawning subagents it also checks for external commits (e.g., made in a separate terminal) and triggers background re-indexing if needed.

## License

MIT

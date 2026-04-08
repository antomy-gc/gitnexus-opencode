# GitNexus OpenCode Plugin — Uninstallation

This document is intended for an AI agent (OpenCode) to follow step by step.

## Step 1: Remove plugin from OpenCode config

Read both config files:
```bash
cat ~/.config/opencode/config.json 2>/dev/null
cat opencode.json 2>/dev/null
```

In every file where `"gitnexus-opencode"` is found in the `plugin` array, remove it.
If the array becomes empty, remove the `plugin` key entirely.

## Step 2: Remove MCP server config

Ask the user: "Do you also want to remove the GitNexus MCP server? (This removes graph query tools from OpenCode)"

If yes: in the same config file(s), remove the `gitnexus` entry from the `mcp` object.
If the `mcp` object becomes empty, remove the key entirely.

If no: leave it — the MCP tools will still work without the plugin, just no auto-refresh or hints.

## Step 3: Remove preference files

Check if preference files exist:
- `.opencode/gitnexus-opencode.json` (project-level)
- `~/.config/opencode/gitnexus-opencode.json` (global)

If found, ask: "Remove GitNexus plugin preferences?"
If yes, delete them. If no, leave them (harmless without the plugin).

## Step 4: Remove GitNexus permissions (if added)

Check `~/.config/opencode/opencode.json` for GitNexus permission entries:
- `gitnexus_query`
- `gitnexus_context`
- `gitnexus_impact`

If found in the `permission` object, ask: "Remove GitNexus tool permissions from OpenCode config?"
If yes, remove those entries. If the `permission` object becomes empty, remove the key entirely.
If no, leave them (harmless without the MCP server).

## Step 5: Uninstall GitNexus CLI (optional)

Only offer this step if the user chose to remove the MCP server in Step 2.
If they kept the MCP server, skip — they still need the CLI.

Check if GitNexus is installed globally:
```bash
gitnexus --version 2>/dev/null || echo "not installed globally"
```

If installed, ask: "Do you also want to uninstall the GitNexus CLI itself?
Note: if you use GitNexus with other tools (Claude Code, Cursor), keep it."

If yes:
```bash
npm uninstall -g gitnexus
```

If not installed globally (npx only): no action needed.

## Step 6: Restart OpenCode

Tell the user: "Restart OpenCode to complete the removal."

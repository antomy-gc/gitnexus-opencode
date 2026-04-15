# GitNexus OpenCode Plugin — Installation

This document is intended for an AI agent (OpenCode) to follow step by step.

## Prerequisites

- OpenCode installed and working
- Node.js 20+ with npm/npx available
- Git installed

## Step 1: Check GitNexus CLI

Check global install first, then npx cache:
```bash
gitnexus --version 2>/dev/null || npx -y gitnexus --version 2>/dev/null || echo "not available"
```

**If not available**: ask the user:
"GitNexus CLI is not installed. Install it?
- **Yes, version 1.5.2** (last known stable, recommended)
- **Yes, latest**
- **No, use npx** (plugin will download on demand, slower first run)"

If installing:
```bash
npm install -g gitnexus@<chosen-version>
```

**If available**: report the current version and how it was found (global or npx). Ask:
"GitNexus <current-version> is available (<global install / npx cache>). What do you want to do?
- **Keep it** — plugin will use this version
- **Switch to 1.5.2** (recommended stable)
- **Switch to a different version**"

If switching and user wants global install:
```bash
npm install -g gitnexus@<chosen-version>
```

If switching but keeping npx-only, just note the version — it will be set in the MCP config and preferences.

Remember the chosen version for subsequent steps.
Default: `1.5.2` if nothing else specified.

## Step 2: Validate and configure MCP server

Read the OpenCode config files:
```bash
cat ~/.config/opencode/config.json 2>/dev/null
cat opencode.json 2>/dev/null
```

### 2a: Validate existing config

If a `gitnexus` MCP entry already exists, validate its structure.
The correct format for OpenCode is:

```json
{
  "mcp": {
    "gitnexus": {
      "type": "local",
      "command": ["npx", "-y", "gitnexus@<chosen-version>", "mcp"]
    }
  }
}
```

Known issues to check for:
- **Wrong format**: `gitnexus setup` may write the MCP config in a format incompatible with OpenCode (e.g., missing `type` field, wrong key structure, extra nesting). If the entry looks different from the format above, it needs to be replaced.
- **Missing `type` field**: OpenCode requires `"type": "local"` for stdio-based MCP servers. If missing, add it.
- **Wrong `command` shape**: must be an array of strings, not a single string.
- **Invalid JSON**: the config file itself may have syntax errors (trailing commas, missing quotes). Validate and fix if needed.

If any issues found, show the user what's wrong and the corrected version. Ask: "The GitNexus MCP config has issues. Fix it?"

### 2b: Version check

If the entry is valid, compare the configured version with the chosen version.
If they differ, ask:
"GitNexus MCP is configured with version <configured-version>, but you chose <chosen-version>. Update it?"
If yes, update the `command` array.
If no, leave as-is.

### 2c: Add if missing

If no `gitnexus` MCP entry exists at all, add it to the global config (`~/.config/opencode/config.json`):

```json
{
  "mcp": {
    "gitnexus": {
      "type": "local",
      "command": ["npx", "-y", "gitnexus@<chosen-version>", "mcp"]
    }
  }
}
```

Merge into existing `mcp` object. Do not replace other MCP servers.

## Step 3: Check plugin config

In the same config file(s) from Step 2, check the `plugin` array.

**If `gitnexus-opencode` is not in the array**: add it:
```json
{
  "plugin": ["gitnexus-opencode"]
}
```
Append to existing `plugin` array. Do not replace other plugins.

**If `gitnexus-opencode` is already present**: no changes needed, report "Plugin already configured."

## Step 4: Allow GitNexus tools for subagents

By default, OpenCode's explore/librarian agents block all non-built-in tools (`"*": "deny"`). To let subagents use GitNexus graph tools directly (instead of falling back to slower CLI via bash), add top-level permissions to `~/.config/opencode/opencode.json`:

```json
{
  "permission": {
    "gitnexus_query": "allow",
    "gitnexus_context": "allow",
    "gitnexus_impact": "allow"
  }
}
```

Merge into the existing file — do not replace other keys.

**If the user declines**: the plugin still works. Subagents will use GitNexus CLI via bash as a fallback (slower, ~3-5s overhead per call).

## Step 5: Configure preferences

Ask: "Do you want GitNexus to automatically refresh stale indexes on session start and after commits? (yes is default)"

Create a preference file only if any setting differs from defaults:

| Setting | Default |
|---------|---------|
| `gitnexusVersion` | `"1.5.2"` |
| `autoRefreshStale` | `true` |
| `autoRefreshOnCommit` | `true` |

If all defaults are fine, skip file creation.

Otherwise, write `~/.config/opencode/gitnexus-opencode.json` (global) or `.opencode/gitnexus-opencode.json` (project) with only the non-default values:
```json
{
  "gitnexusVersion": "<chosen-version>",
  "autoRefreshStale": false
}
```

## Step 6: Restart OpenCode

Tell the user: "Restart OpenCode to activate the GitNexus plugin.
On the next session start, the plugin will automatically detect missing or stale indexes and offer to build them."

## Verification

After restart, the plugin should:
- Log a message on session start if indexes are stale or missing
- Inject graph prerequisite hints when the `init-deep` or `init` skill is loaded
- Silently refresh indexes after git commits (commit, merge, rebase, etc.)
- Automatically prepend the graph hint envelope to main-session user messages via `experimental.chat.messages.transform`
- Prepend the envelope to subagent user messages ONLY when the orchestrator added the `[[gitnexus:graph]]` opt-in marker to the subagent prompt

## Configuration Reference

Preference file: `~/.config/opencode/gitnexus-opencode.json` (global) or `.opencode/gitnexus-opencode.json` (project)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `gitnexusVersion` | string | `"1.5.2"` | npm package version for gitnexus CLI |
| `autoRefreshStale` | boolean | `true` | Auto-refresh stale indexes on session start |
| `autoRefreshOnCommit` | boolean | `true` | Auto-refresh after git mutations |

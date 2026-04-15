# gitnexus-opencode

OpenCode plugin for [GitNexus](https://github.com/nicepkg/gitnexus) — automatic code graph indexing, staleness detection, and AI agent hints.

## What it does

**On session start:**
- Verifies GitNexus CLI is reachable (disables plugin if not)
- Discovers git repos (current dir + subdirectories)
- Tracks the session as a main (top-level) session so the graph hint envelope is automatically prepended to its user messages by the `experimental.chat.messages.transform` hook
- Shows toast with graph status (delayed 6s to avoid oh-my-openagent spinner overlap)
- Background-refreshes stale indexes

**Tools:**

- `gitnexus_query`, `gitnexus_context`, `gitnexus_impact` — from GitNexus MCP server. Available to all agents including subagents (requires [permission setup](#allow-gitnexus-tools-for-subagents)).
- `gitnexus_analyze` — plugin tool for building/refreshing the graph. Intended for the main agent (re-indexing is expensive, ~30-120s). By default it is NOT delegated to subagents unless explicitly permitted in opencode.json.

**Tool hooks:**

| Hook | Trigger | Action |
|------|---------|--------|
| `tool.execute.after` on `skill` | Skill loaded | Inject graph prerequisite for `init-deep`/`init`, availability hint for others |
| `tool.execute.after` on `bash` | Git mutation detected | Background re-index (cache flips to `freshness=refreshing`, then back to `up_to_date`) |
| `experimental.chat.messages.transform` | Every LLM call | Prepend the graph-hint envelope to the last user message of eligible sessions (main sessions automatically; subagents only if the orchestrator added the `[[gitnexus:graph]]` marker) |

**Graph hint envelope:**

Instead of force-pushing context into every spawned subagent, the plugin maintains a single XML-wrapped envelope that describes the indexed repos, the preferred MCP / CLI tools, when to use the graph vs grep, and how to propagate access to subagents. The envelope is rebuilt on demand and is **read fresh on every LLM turn**, so agents always see the current freshness state (`up_to_date` / `refreshing` / `may_be_stale` / `missing`).

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
| `autoRefreshStale` | `true` | Refresh stale indexes on session start |
| `autoRefreshOnCommit` | `true` | Refresh after git commit/merge/rebase |

## Build

```bash
npm run build    # tsc + esbuild bundle
```

Produces `dist/gitnexus-opencode.js` — single file, all internal modules bundled, `@opencode-ai/plugin` as external (resolved from OpenCode runtime).

## Architecture

### Envelope delivery

The graph hint is delivered through OpenCode's `experimental.chat.messages.transform` hook. On every LLM call the plugin:

1. Finds the last user message in the transient message array OpenCode is about to send to the model
2. Decides eligibility:
   - **Main session** (top-level, no `parentID`) — always eligible
   - **Subagent session** — eligible only if the orchestrator wrote the explicit opt-in marker `[[gitnexus:graph]]` into the subagent's prompt
3. If eligible, scrubs any leading `<gitnexus_graph>...</gitnexus_graph>` block left over from a previous turn (idempotency across compaction), strips the opt-in marker if present, and prepends the fresh envelope to the user message text
4. Logs an `info`-level summary line so the behavior is observable from the plugin log file

The envelope is prepended to the **user message**, never to the system prompt. This preserves provider-side prefix caching for the system prompt — Anthropic's cached input is roughly 5x cheaper than uncached input, and we deliberately avoid breaking that.

### Auto-refresh on git mutations

The `tool.execute.after` hook watches for git mutation commands (`commit`, `merge`, `rebase`, `pull`, `cherry-pick`, `switch`, `reset`). When one is detected in a `bash` call, the plugin:

1. Marks the affected repo as refreshing in the hint cache and rebuilds the cache immediately, so the very next user turn sees `freshness="refreshing"`
2. Spawns `gitnexus analyze` in the background (detached, output piped to /dev/null)
3. On process close, marks the repo as no longer refreshing and rebuilds the cache again, so the next turn sees `freshness="up_to_date"` (or `may_be_stale` if HEAD drifted again during analyze)

### For orchestrators

The graph envelope is **opt-in for subagents**. The orchestrator (Sisyphus, Prometheus, OMO, your custom main agent, etc.) decides per spawn whether the subagent should see the graph by including the marker `[[gitnexus:graph]]` anywhere in the subagent's prompt text. The plugin detects the marker, prepends the envelope, and strips the marker so the subagent never sees it as literal text.

**Recommended grant:**

- `explore`, `deep`, `build`, `quick`, `refactor`, `sisyphus-junior`, and other coding-focused agents — pass the marker
- Agents that touch real source files for structural questions (call chains, dependencies, blast radius) — pass the marker

**Recommended skip (no marker):**

- `librarian`, doc/knowledge lookup agents
- `oracle` and other reasoning-only agents
- Plan critics (`Momus`, `Metis`), plan builders (`Prometheus`)
- Writing / multimodal / non-code agents

Skipping the marker for these agents saves roughly 600 tokens per spawn and keeps their context focused on their actual job.

**Example spawn (from a main agent):**

```
task(
  subagent_type="explore",
  prompt="[[gitnexus:graph]] List every caller of buildEnvelope in the repo"
)
```

Inside the spawned subagent the prompt becomes:

```xml
<gitnexus_graph source="gitnexus" version="1" freshness="up_to_date">
  <summary>Code knowledge graph is available. Graph is current.</summary>
  <indexed_repos>...</indexed_repos>
  <preferred_tools>...</preferred_tools>
  <when_to_use>...</when_to_use>
  <subagent_propagation>...</subagent_propagation>
</gitnexus_graph>

List every caller of buildEnvelope in the repo
```

The marker itself is gone — the subagent only sees the envelope and the cleaned prompt.

## Uninstall

Remove `~/.config/opencode/plugins/gitnexus-opencode.js` and restart OpenCode.

If you added GitNexus permissions to `opencode.json`, remove the `gitnexus_query`, `gitnexus_context`, `gitnexus_impact` entries from the `permission` object.

If your orchestrator prompts contain literal `[[gitnexus:graph]]` markers, those become harmless inert text once the plugin is removed. You can leave them or strip them at your convenience.

For full cleanup see [UNINSTALL.md](./UNINSTALL.md).

## License

MIT

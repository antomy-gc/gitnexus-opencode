# gitnexus-opencode

OpenCode plugin for [GitNexus](https://github.com/nicepkg/gitnexus) — automatic code graph indexing, staleness detection, and AI agent hints.

## What it does

**On session start:**
- Verifies GitNexus CLI is reachable (disables plugin if not)
- Discovers git repos (current dir + subdirectories)
- Tracks the session as a main (top-level) session so the dynamic graph envelope is automatically prepended to its user messages
- Shows toast with graph status (delayed 6s to avoid oh-my-openagent spinner overlap)
- Background-refreshes stale indexes

**Every chat turn:**
- Pushes a static GitNexus rule block onto the system prompt (cache-friendly, byte-identical between turns)
- Prepends the dynamic indexed-repo envelope to the last user message of eligible sessions

**Tools:**

- `gitnexus_query`, `gitnexus_context`, `gitnexus_impact`, and other `gitnexus_*` tools — from the GitNexus MCP server. Available to all agents including subagents (requires [permission setup](#allow-gitnexus-tools-for-subagents)).
- `gitnexus_analyze` — plugin tool for building/refreshing the graph. Intended for the main agent (re-indexing is expensive, 3-120s depending on repo size). By default it is NOT delegated to subagents unless explicitly permitted in opencode.json.

**Hooks:**

| Hook | Trigger | Action |
|------|---------|--------|
| `tool.execute.after` on `skill` | Skill loaded | Inject graph prerequisite for `init-deep`/`init`, availability hint for others |
| `tool.execute.after` on `bash` | Git mutation detected | Background re-index (cache flips to `freshness=refreshing`, then back to `up_to_date`) |
| `experimental.chat.system.transform` | Every LLM call | Push the static GitNexus rule block onto `output.system` (idempotent; skipped if plugin disabled or already present) |
| `experimental.chat.messages.transform` | Every LLM call | Prepend the dynamic graph envelope to the last user message of eligible sessions (main sessions automatically; subagents only if the orchestrator added the `[[gitnexus:graph]]` marker) |

## Two-layer hint architecture

The plugin contributes two distinct pieces of context per chat turn:

**Layer 1 — static system addendum (in system prompt).**
Rules that don't change between sessions: envelope contract, subagent propagation rules, tool preference, and (for main sessions) the "build a graph yourself" cost/benefit rule. Module-level constant strings, byte-identical across every turn — provider prefix caches keep matching, so the static block is amortized to roughly cached-input cost (≈5× cheaper than uncached on Anthropic).

There are two variants:
- **Full** addendum (~475 tokens) — pushed onto **main** sessions. Covers everything including subagent propagation rules and the build-graph rule.
- **Lite** addendum (~160 tokens) — pushed onto **subagent** sessions. Covers only the envelope contract and tool preference. Omits subagent propagation (subagents rarely spawn further subagents) and the build-graph rule (`gitnexus_analyze` is intended for the main agent).

The variant is chosen per chat call from the `sessionID` and the `mainSessions` registry. When `sessionID` is absent the hook conservatively defaults to the full variant.

**Layer 2 — dynamic envelope (in user message).**
Per-instance data that does change: which repos are indexed in this workspace right now, their paths, and freshness state. Read fresh on every turn. The envelope cross-references the system prompt for the rules instead of duplicating them.

Splitting puts the **rules** in the highest-salience location for instruction-following (system prompt) and keeps **data** in the natural per-turn refresh location (user message). On warm-cache turns the per-turn cost is significantly lower than the previous monolithic envelope; subagents specifically pay roughly a third of what main sessions pay for the static block.

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

### System addendum delivery (Layer 1)

The static rule block is delivered through `experimental.chat.system.transform`. On every LLM call the plugin appends one of the two addendum variants to `output.system`:

- **Full** for main sessions (or when `sessionID` is absent — conservative default)
- **Lite** for sessions positively identified as subagents via the `mainSessions` registry

Skipped if:
- the plugin is disabled (CLI unreachable), or
- any gitnexus addendum is already present in the array (idempotency, detected via the start sentinel — works across both variants).

Both variants are wrapped between the same sentinels `<!-- gitnexus:system:start -->` and `<!-- gitnexus:system:end -->`. Neither variant contains per-instance interpolations, so each is byte-identical between turns and across sessions — provider prefix caches match and the cached-input price applies after the first turn.

The addendum is pushed for every session where the plugin is active, including ones launched from a directory with no locally indexed repos. In that case the addendum tells the agent to call `gitnexus_list_repos` once to discover repos indexed elsewhere on the machine.

### Envelope delivery (Layer 2)

The dynamic envelope is delivered through OpenCode's `experimental.chat.messages.transform` hook. On every LLM call the plugin:

1. Finds the last user message in the transient message array OpenCode is about to send to the model
2. Decides eligibility:
   - **Main session** (top-level, no `parentID`) — always eligible
   - **Subagent session** — eligible only if the orchestrator wrote the explicit opt-in marker `[[gitnexus:graph]]` into the subagent's prompt
3. If eligible, scrubs any leading `<gitnexus_graph>...</gitnexus_graph>` block left over from a previous turn (idempotency across compaction), strips the opt-in marker if present, and prepends the fresh envelope to the user message text
4. Logs an `info`-level summary line so the behavior is observable from the plugin log file

The envelope itself is small (`<summary>`, `<indexed_repos>`, and a `<rules>` cross-reference back to the system prompt). It is read fresh on every LLM turn, so agents always see the current freshness state (`up_to_date` / `refreshing` / `may_be_stale` / `missing`).

### Auto-refresh on git mutations

The `tool.execute.after` hook watches for git mutation commands (`commit`, `merge`, `rebase`, `pull`, `cherry-pick`, `switch`, `reset`). When one is detected in a `bash` call, the plugin:

1. Marks the affected repo as refreshing in the hint cache and rebuilds the cache immediately, so the very next user turn sees `freshness="refreshing"`
2. Spawns `gitnexus analyze` in the background (detached, output piped to /dev/null)
3. On process close, marks the repo as no longer refreshing and rebuilds the cache again, so the next turn sees `freshness="up_to_date"` (or `may_be_stale` if HEAD drifted again during analyze)

### For orchestrators

The static rule block in the system prompt teaches every main agent how the propagation marker works and when to use it — including which `subagent_type` values qualify, the path-based override rule, and when to build a graph yourself for deep investigation of an unindexed repo. You don't need to teach this from scratch in your orchestrator system prompt; it's already there.

The orchestrator (Sisyphus, Prometheus, OMO, your custom main agent, etc.) decides per spawn whether the subagent should see the dynamic envelope by including the marker `[[gitnexus:graph]]` anywhere in the subagent's prompt text. The plugin detects the marker, prepends the envelope, and strips the marker so the subagent never sees it as literal text.

**Recommended grant** (parent should add the marker):
- `explore`, `deep`, `build`, `quick`, `refactor`, `sisyphus-junior`, `general` — code-investigation agents
- Any subagent whose prompt mentions an absolute path inside an indexed repo, regardless of `subagent_type`

**Recommended skip** (parent omits the marker):
- `librarian`, doc/knowledge lookup agents
- `oracle` and other reasoning-only agents
- Plan critics (`Momus`, `Metis`), plan builders (`Prometheus`)
- Writing / multimodal / non-code agents

A lite variant of the rule block is pushed onto every subagent's system prompt by the same `system.transform` hook, so even a subagent spawned without the marker still knows the envelope contract (`gitnexus_list_repos` for self-discovery if the orchestrator forgot the marker) and the tool preference list. The marker controls only whether the **per-instance repo data** is delivered as a user-message envelope.

**Example spawn (from a main agent):**

```
task(
  subagent_type="explore",
  prompt="[[gitnexus:graph]] List every caller of buildEnvelope in the repo"
)
```

Inside the spawned subagent the prompt becomes:

```xml
<gitnexus_graph source="gitnexus" version="2" freshness="up_to_date">
<summary>Code knowledge graph is available. Graph is current.</summary>
<indexed_repos>
<repo name="myproj" path="/Users/me/code/myproj"/>
</indexed_repos>
<rules>See the GitNexus section of the system prompt for tool preference and subagent propagation rules (marker [[gitnexus:graph]]).</rules>
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

# gitnexus-opencode

OpenCode plugin for [GitNexus](https://github.com/nicepkg/gitnexus) — automatic code graph indexing, staleness detection, and AI agent hints.

## What it does

**On session start:**
- Verifies GitNexus CLI is reachable (disables plugin if not)
- Discovers git repos (current dir + subdirectories)
- Classifies the session: subagents are tracked by `parentID`; everything else defaults to main and gets the dynamic graph envelope on its user messages
- Hydrates the subagent registry from `client.session.list()` so long-lived subagents survive plugin reloads
- Shows toast with graph status (delayed 6s to avoid oh-my-openagent spinner overlap)
- Background-refreshes stale indexes

**Every chat turn:**
- Pushes a static GitNexus rule block onto the system prompt (cache-friendly, byte-identical between turns)
- Prepends the dynamic indexed-repo envelope to the last user message of eligible sessions
- Deduplicates the envelope per session: if the next-turn envelope is byte-identical to what was last injected into this session, injection is skipped — the agent already carries it in conversation history

**Tools:**

- `gitnexus_query`, `gitnexus_context`, `gitnexus_impact`, and other `gitnexus_*` tools — from the GitNexus MCP server. Available to all agents including subagents (requires [permission setup](#allow-gitnexus-tools-for-subagents)).
- `gitnexus_analyze` — plugin tool for building/refreshing the graph. Intended for the main agent. By default it is NOT delegated to subagents unless explicitly permitted in opencode.json.

**Hooks:**

| Hook | Trigger | Action |
|------|---------|--------|
| `tool.execute.after` on `skill` | Skill loaded | Inject graph prerequisite for `init-deep`/`init`, availability hint for others |
| `tool.execute.after` on `bash` | Git mutation detected | Background re-index (cache flips to `freshness=refreshing`, then back to `up_to_date`) |
| `experimental.chat.system.transform` | Every LLM call | Push the static GitNexus rule block onto `output.system` (idempotent; skipped if plugin disabled or already present) |
| `experimental.chat.messages.transform` | Every LLM call | Prepend the dynamic graph envelope to the last user message of eligible sessions (main sessions automatically; subagents only if the orchestrator added the `[[gitnexus:graph]]` marker). Skips injection when the envelope is byte-identical to the last one injected into this session (per-session dedup). |

## Two-layer hint architecture

The plugin contributes two distinct pieces of context per chat turn:

**Layer 1 — static system addendum (in system prompt).**
Rules that don't change between sessions: envelope contract, subagent propagation rules, tool preference, a delegate-to-subagent nudge for open-ended graph work, and (for main sessions) the "build a graph yourself" cost/benefit rule. Module-level constant strings, byte-identical across every turn — provider prefix caches keep matching, so the static block is amortized to roughly cached-input cost (≈5× cheaper than uncached on Anthropic).

There are two variants:
- **Full** addendum (~510 tokens) — pushed onto **main** sessions. Covers everything: envelope contract, subagent propagation rules, delegate-to-subagent nudge, and the build-graph rule.
- **Lite** addendum (~160 tokens) — pushed onto **subagent** sessions. Covers only the envelope contract and tool preference. Omits subagent propagation (subagents rarely spawn further subagents) and the build-graph rule (`gitnexus_analyze` is intended for the main agent).

The variant is chosen per chat call from the `sessionID` and the `SessionRegistry`. The registry tracks **subagents** positively (by `parentID`) and defaults unknown sessions to **main** — the safer failure mode, since the dynamic envelope is independently gated by the `[[gitnexus:graph]]` marker check.

**Layer 2 — dynamic envelope (in user message).**
Per-instance data that does change: which repos are indexed in this workspace right now, their paths, and freshness state. Read fresh on every turn. The envelope cross-references the system prompt for the rules instead of duplicating them.

The envelope is **deduplicated per session**: a `LastInjectedRegistry` memoizes the last envelope injected into each session. If the next-turn envelope is byte-identical (no freshness flips, no repos added/removed), the hook skips injection — the agent already has it in conversation history, and re-injecting would only burn uncached input tokens. The memo clears on session deletion or when `<gitnexus_graph>` no longer appears in visible history (compaction guard), so the next turn force-re-injects.

Splitting puts the **rules** in the highest-salience location for instruction-following (system prompt) and keeps **data** in the natural per-turn refresh location (user message). On warm-cache turns the per-turn cost is significantly lower than the previous monolithic envelope; subagents specifically pay roughly a third of what main sessions pay for the static block. On a stable repo state, a long session pays the envelope cost exactly once instead of N times.

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
      "command": ["npx", "-y", "gitnexus@1.6.5", "mcp"]
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
  "gitnexusVersion": "1.6.5",
  "autoRefreshStale": true,
  "autoRefreshOnCommit": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `gitnexusVersion` | `"1.6.5"` | Pin the gitnexus npm version |
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

- **Full** for main sessions (and for unknown sessions — conservative default, see below)
- **Lite** for sessions positively identified as subagents via the `SessionRegistry`

Skipped if:
- the plugin is disabled (CLI unreachable), or
- any gitnexus addendum is already present in the array (idempotency, detected via the start sentinel — works across both variants).

Both variants are wrapped between the same sentinels `<!-- gitnexus:system:start -->` and `<!-- gitnexus:system:end -->`. Neither variant contains per-instance interpolations, so each is byte-identical between turns and across sessions — provider prefix caches match and the cached-input price applies after the first turn.

The full addendum also nudges the main agent to **delegate open-ended exploration or multi-flow tracing to a subagent** with the `[[gitnexus:graph]]` marker, instead of stacking inline `gitnexus_*` calls. This keeps the main agent's context clean on multi-step graph workflows where each tool response (~2-10KB) would otherwise accumulate in history.

The addendum is pushed for every session where the plugin is active, including ones launched from a directory with no locally indexed repos. In that case the addendum tells the agent to call `gitnexus_list_repos` once to discover repos indexed elsewhere on the machine.

#### Session classification (subagent vs. main)

The `SessionRegistry` tracks **subagent** sessions positively (by presence of `parentID` on `session.created`) and defaults unknown sessions to **main**. This is the safe failure mode: misclassifying an unknown session as main only adds harmless extra text to its system prompt, while the user-message envelope is still gated by the `[[gitnexus:graph]]` marker check in `messages.transform` — so an unmarked subagent does NOT receive the envelope just because it was misclassified.

On plugin init the registry is **hydrated** from `client.session.list()`: every existing session with a `parentID` is re-registered as a subagent. This way long-lived subagents survive plugin reloads and session compaction without being silently re-classified as main and seeing the wrong addendum variant.

### Envelope delivery (Layer 2)

The dynamic envelope is delivered through OpenCode's `experimental.chat.messages.transform` hook. On every LLM call the plugin:

1. Finds the last user message in the transient message array OpenCode is about to send to the model
2. Decides eligibility:
   - **Main session** (top-level, no `parentID`) — always eligible
   - **Subagent session** — eligible only if the orchestrator wrote the explicit opt-in marker `[[gitnexus:graph]]` into the subagent's prompt
3. **Per-session dedup check**: if the next-turn envelope is byte-identical to the one last injected into this session, skip injection. Strip the opt-in marker if present (otherwise it would leak into subagent prompts as literal text) and exit. The agent already has the envelope in conversation history.
4. If the envelope is new (or the registry was cleared by compaction), scrubs any leading `<gitnexus_graph>...</gitnexus_graph>` block left over from a previous turn (idempotency), strips the opt-in marker, and prepends the fresh envelope to the user message text. Records the injection in the `LastInjectedRegistry`.
5. Logs an `info`-level summary line so the behavior is observable from the plugin log file

The envelope itself is small (`<summary>`, `<indexed_repos>`, and a `<rules>` cross-reference back to the system prompt). It is read fresh on every LLM turn, so agents always see the current freshness state (`up_to_date` / `refreshing` / `may_be_stale` / `missing`).

**Compaction guard.** The handler clears the per-session memo when no `<gitnexus_graph>` block survives in the visible message history. After OpenCode compacts a session, the next turn force-re-injects so the agent never operates without the envelope when it expects one.

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

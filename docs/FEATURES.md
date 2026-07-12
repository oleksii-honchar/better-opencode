# better-opencode Features

This document describes the thirteen features added by the `better-opencode` fork.

For an overview of the fork's purpose and installation, see [BETTER-OPENCODE.md](./BETTER-OPENCODE.md).

---

## 1. `tool.execute.after` Inject (PR #19519)

📋 [Detailed Spec](./spec/02-tool-execute-after-inject.md)

**Status:** ✅ Implemented

Plugins can inject synthetic user messages after tool execution. These messages are persisted and visible to the AI on the next loop iteration.

**Example plugin:**
```typescript
// After every file edit, remind agent to update progress.md
"tool.execute.after": async (input, output) => {
  if (input.tool === "edit") {
    output.inject = [{
      role: "system",
      text: "Remember: update progress.md after file changes."
    }];
  }
}
```

> **Note:** `role: "system"` injections are automatically wrapped in `<system-reminder>` tags by the framework. Use `role: "user"` for plain user messages.

---

## 2. `session.stopping` Hook (PR #16598)

📋 [Detailed Spec](./spec/03-session-stopping-hook.md)

**Status:** ✅ Implemented

Plugins can intercept the agent's idle/stop state and inject a follow-up message instead of stopping. The hook fires in `prompt.ts`'s `runLoop` before the loop exits. Two safeguards prevent abuse: `stop: false` requires a message, and a max continuation counter (3) prevents infinite loops.

**Example plugin:**
```typescript
// Prevent agent from stopping if progress.md hasn't been updated
"session.stopping": async (input, output) => {
  if (input.reason === "idle") {
    const progressExists = await fileExists("progress.md");
    if (!progressExists) {
      output.stop = false;
      output.message = "You haven't updated progress.md yet — continue working.";
    }
  }
}
```

> **Note:** `output.message` is required when `output.stop = false`. The framework automatically wraps the message in `<system-reminder>` tags via `flushInjectedMessages` with `role: "system"`.

---

## 3. Session ID in System Prompt

📋 [Detailed Spec](./spec/01-session-id-system-prompt.md)

**Status:** ✅ Implemented

The current `sessionID` and `parentSessionID` are included in the system prompt `<env>` block on every LLM call. This survives compaction because the system prompt is rebuilt from scratch each turn.

**System prompt output:**
```
You are powered by the model named claude-sonnet-4. The exact model ID is anthropic/claude-sonnet-4
Here is some useful information about the environment you are running in:
<env>
  Working directory: /Users/oleksii.honchar/project
  Workspace root folder: /Users/oleksii.honchar/project
  Is directory a git repo: yes
  Platform: darwin
  Today's date: Fri Apr 24 2026
  Session ID: ses_241c208c9ffeI6DgeZh6Qhu3sl
  Parent Session ID: ses_abc123def456
</env>
```

---

## 4. Multi-Repo Worktree Discovery

📋 [Detailed Spec](./spec/04-multi-repo-worktree-discovery.md)

**Status:** ⏳ Pending — New feature proposal

**Main purpose:** Avoid expensive `find *` global search calls by giving the agent a list of known working directories upfront.

In multi-repo and monorepo environments, the agent discovers and enumerates all related git repositories in the `<env>` block. This enables intelligent navigation and file access across repo boundaries, including sibling repos, nested repos, and git worktrees.

**System prompt output (multi-repo example):**
```
<env>
  Working directory: /Users/oleksii.honchar/workspace/my-app
  Workspace root folder: /Users/oleksii.honchar/workspace/my-app
  Is directory a git repo: yes
  Platform: darwin
  Today's date: Fri Apr 24 2026
  Session ID: ses_241c208c9ffeI6DgeZh6Qhu3sl
  Parent Session ID: ses_abc123def456
  Repositories:
  ▶  /Users/oleksii.honchar/workspace/my-app
    /Users/oleksii.honchar/workspace/other-app
    /Users/oleksii.honchar/workspace/shared-lib
</env>
```

---

## 5. Static MCP Server Filtering by Category and Tool

📋 [Detailed Spec](./spec/05-static-mcp-filtering.md)

**Status:** ✅ Implemented

**Problem:** opencode exposes **150+ tool definitions** to **every agent session** regardless of relevance, creating **~225,000 tokens of context pollution per session**.

**Solution:** Two-tier filtering:
1. **Server-level category filtering** — Each MCP server optionally declares a `category` string. Each agent frontmatter declares `allowedMcpCategories` array. At agent spawn, only MCP servers whose category matches are loaded.
2. **Per-tool filtering** — Each MCP server optionally declares `enabledTools` (whitelist) or `disabledTools` (blacklist). Tool filtering applies **after** category filtering.

No predefined categories — user-defined, user-driven.

**MCP server config (category + tool filtering):**
```jsonc
{
  "mcp": {
    "github":  { "enabled": true, "category": "code", "enabledTools": ["read_file", "list_issues"] },
    "datadog": { "enabled": true, "category": "observability", "disabledTools": ["execute_query"] },
    "slack":   { "enabled": true, "category": "office" }
  }
}
```

**Agent frontmatter:**
```yaml
name: developer
allowedMcpCategories: [core, code, observability, browser]
```

**Result:** Developer agent gets ~80 tools instead of 150+ — **47% context reduction**. Session-manager gets ~15 tools — **90% reduction**.

**Filtering order:** Category filter → Tool filter. If category filter excludes the server, tool filter is not evaluated.

---

## 6. Attachment Resolution

📋 [Detailed Spec](./spec/07-attachment-resolution.md)

**Status:** ✅ Implemented

**Problem:** Vision models can *see* attached images but cannot *extract* base64 data to construct tool call arguments. When the LLM calls `extract_bytes(data: ???)`, it has no way to pass the file data — the data URL is only in the FilePart for visual rendering, not accessible as text.

**Solution:** Store attachments as temp files with `opencode://attachment/<uuid>.<ext>` URIs, inject URI references into the prompt as synthetic text parts, and intercept MCP tool execution to resolve URIs to base64 before forwarding.

**Flow:**
```
User attaches image → resolvePart stores temp file + generates URI
→ Prompt includes: FilePart(visual) + synthetic text("Attached file: photo.png — use \"opencode://attachment/abc123.png\" as the data argument for tools like extract_bytes")
→ System prompt includes: "## File Attachments" (conditional, when attachments present)
→ LLM calls extract_bytes(data: "opencode://attachment/abc123.png")
→ convertMcpTool intercepts, resolves URI → base64
→ Tool receives valid base64 → success
```

**Components:**
- **`session/attachment.ts`** — `store()`, `resolve()`, `trackForMessage()`, `cleanup()`, `hasAttachments()` functions
- **`session/prompt.ts`** — `resolvePart` stores non-text attachments, injects synthetic URI text parts (instructional format), conditionally injects `FILE_ATTACHMENTS_SYSTEM_PROMPT` into system array
- **`mcp/index.ts`** — `convertMcpTool` intercepts tool args, resolves `opencode://attachment/` URIs to base64
- **Cleanup lifecycle** — Runs after LLM loop completes (not as a scope finalizer that fires before tool calls)

**URI format:** `opencode://attachment/{uuid}.{ext}` — UUID-based filename with original extension, stored in `{os.tmpdir()}/opencode-attachments/`

**Two-Layer LLM Instruction (D24):** The LLM needs explicit instruction to use the URI scheme correctly. Without it, the model may treat URIs as file paths, URLs, or ignore them entirely.

- **Layer 1 — System Prompt Injection:** A `## File Attachments` section is conditionally injected into the system prompt (between general instructions and skills) when the current message has tracked attachments. Explains the URI scheme, instructs the LLM to pass URIs as-is to tools like `extract_bytes`, and warns against treating URIs as file paths or URLs. ~100 tokens when present, 0 when absent.
- **Layer 2 — Instructional Synthetic Text:** The synthetic text part uses an instructional format (not merely informational): `Attached file: photo.png — use "opencode://attachment/abc123.png" as the data argument for tools like extract_bytes`. The em dash and "use" directive make the action explicit at the point of reference.

The system prompt gives the LLM the general rule; the synthetic text applies it to each specific attachment. Together they eliminate ambiguity — the LLM knows both the pattern (from the system prompt) and the concrete instance (from the synthetic text).

**Vision Flag Check (Step 2.3):** Before constructing a user message, opencode checks whether the active model has vision capability via `capabilities.input.image` (derived from models.dev `modalities.input.includes("image")`). Vision models receive both the `FilePart` (visual image) and the synthetic text URI. Non-vision models receive only the synthetic text URI — they cannot *see* the image but can still pass the URI to tools like `extract_bytes` for extraction. No new configuration property was introduced; the existing modalities array is used as the sole source of truth.

---

## 7. Unstuck Plugin — Loop Detection and Recovery

📋 [Detailed Spec](./spec/08-unstuck-plugin.md)

**Status:** ✅ Implemented

**Problem:** The existing `doom_loop` mechanism only detects exact tool+input matches (same tool, same input, 3 consecutive times). It misses the most common loop pattern: same thinking → same tool call → same result → repeat, where the model slightly varies the tool input each time.

**Solution:** The Unstuck plugin wraps the LLM stream to detect loops at three levels:

1. **Step-level** — Same thinking→tool-call pattern repeating across steps
2. **Sentence-level** — Same sentence repeating periodically within a single step
3. **Tool-only** — Same tools repeating across steps, regardless of thinking differences

When a loop is detected, the plugin performs **nudge-and-prune**: aborts the stream, prunes the looping assistant messages, injects a nudge message telling the model to break the loop, and restarts the stream. If nudge fails after `maxNudges` attempts, falls back to abort.

**Configuration (opencode.json):**
```json
{
  "unstuck": {
    "enabled": true,
    "loopThreshold": 3,
    "strategy": "nudge-and-prune",
    "maxNudges": 2,
    "logLevel": "warn"
  }
}
```

All fields are optional with sensible defaults. Set `enabled: false` to disable.

---

## 8. Compaction Threshold Fix — Double-Trigger Bug

📋 [Detailed Spec](./spec/06-compaction-threshold-fix.md)

**Status:** ✅ Implemented

**Problem:** The `/compact` command fired **twice immediately in succession** and sometimes triggered at **~75% capacity** instead of the configured 99% threshold, wasting tokens and confusing users.

**Root cause:** After `compaction.create()` creates an entry, the loop continues but `lastFinished.tokens` remains stale — it still reflects the PREVIOUS message's token count. This causes `isOverflow` to re-fire on the next iteration with outdated data.

**Fix:** After `compaction.create()`, immediately clear the stale token reference:

```typescript
Object.assign(lastFinished.tokens, { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } })
```

**Result:** Compaction fires exactly once per overflow event. The ~75% threshold is correct math (threshold applies to input-capacity, not full window).

---

## 9. Agent LLM Params Per Agent (`modelPreset`)

📋 [Detailed Spec](./spec/09-agent-model-preset.md)

**Status:** ✅ Implemented

**Problem:** Users cannot define per-agent LLM parameters beyond `temperature` and `top_p`. Forces them to either define separate model IDs in llama-swap for each parameter combination, or use the same model for all agents.

**Solution:** The `modelPreset` field appends a known suffix (`-precise`, `-instruct`) to the inherited session model ID, then looks up the suffixed model in the provider (e.g., llama-swap). All parameter tuning lives in llama-swap — opencode only selects the model variant.

**Agent config example:**
```yaml
name: precise-coder
modelPreset: "precise"
---
You are a precise coding agent. Generate code directly without reasoning.
```

**Precedence:** `agent.model` (explicit) → `agent.modelPreset + parentModel` (suffixed) → `parentModel` (fallback if suffixed not found)

**Fallback:** If suffixed model not found in provider, logs a warning and falls back to the base (parent) model. Does NOT error — prevents workflow breaks.

---

## 10. Multi-Provider Model Setup (`models:`)

📋 [Detailed Spec](./spec/13-multi-provider-model-setup.md)

**Status:** ✅ Implemented

**Problem:** The `model:` and `modelPreset:` fields support only a single model per agent or a suffix-based variant. When the parent session uses a different provider (e.g., deepseek vs mammoth), the sub-agent gets the wrong provider or fails. Agent developers must maintain separate agent files per provider.

**Solution:** The `models:` field accepts an array of provider-prefixed model ID strings. When a sub-agent is invoked, the system matches the parent's provider against the `models:` list and picks the corresponding model. Falls through to existing resolution chain when no match.

**Agent config example:**
```yaml
# agents/researcher.md
---
name: researcher
mode: subagent
description: Multi-provider capable research agent

# Provider-specific model selection
models:
  - mammoth/qwen3.6-40b
  - deepseek/deepseek-v4-flash
  - codex/gpt-5

# Fallback when provider not in list (deprecated, but functional)
model: mammoth/qwen3.6-40b
---
```

**Resolution chain (strict priority):**

1. `models:` list — iterate entries, match `providerID === parentModel.providerID` (exact match). First match wins. If no match, fall through.
2. `model:` — return the explicitly specified model. **Deprecated** — use `models:` instead.
3. `modelPreset:` — compute `modelID = parentModel.modelID + modelPreset`, using `parentModel.providerID`. **Deprecated** — use `models:` instead.
4. Parent model — inheritance (no agent-level model field defined).

**Provider-Model String Format:**

Each `models:` entry is a `{providerID}/{modelID}` string parsed by `Provider.parseModel()`:

- `mammoth/qwen3.6-40b` → `{ providerID: "mammoth", modelID: "qwen3.6-40b" }`
- `deepseek/deepseek-v4-flash` → `{ providerID: "deepseek", modelID: "deepseek-v4-flash" }`

**Matching Rules:**

- **Exact match only** — `providerID === parentModel.providerID`. No fuzzy matching, prefix matching, or wildcards.
- **First match wins** — if multiple entries have the same providerID, the first is used.
- **Unmatched providers** — fall through to `model:`, then `modelPreset:`, then parent model. No error thrown.

**Deprecation Plan:**

Both `model:` and `modelPreset:` are deprecated. They remain functional as fallbacks in the resolution chain during the deprecation period. Migration guide:

| Old Format | New Format |
|------------|------------|
| `model: mammoth/qwen3.6-40b` | `models:\n  - mammoth/qwen3.6-40b` |
| `modelPreset: -precise` | `models:\n  - mammoth/qwen3.6-40b\n  - deepseek/deepseek-v4-flash` |

**Files Changed:**

| File | Change | Lines |
|------|--------|-------|
| `config/agent.ts` | Added `models` field to AgentSchema + KNOWN_KEYS | 5 |
| `agent/agent.ts` | Added `models` to Info schema, config parsing, extended `resolveAgentModel` | 28 |
| `tool/task.ts` | Pass `next.models` to `resolveAgentModel` | 2 |

**Test Coverage:** 40 tests across 4 files, all passing.

**Key Design Decisions (5 ADRs):**

- Add `models:` field as array of `provider/modelID` strings (ADR-0022)
- Resolution priority: `models:` → `model:` → `modelPreset:` → parent (ADR-0023)
- Exact `providerID ===` comparison, no fuzzy/wildcard matching (ADR-0024)
- Graceful fallback — fall through to existing chain, not hard error (ADR-0025)
- Deprecate `model:` and `modelPreset:` after `models:` is stable (ADR-0026)

---

## 11. Store VS Code Workspace Paths in `<env>`

📋 [Detailed Spec](./spec/10-store-workspace-paths.md)

**Status:** ✅ Implemented

**Problem:** The opencode agent has no awareness of VS Code workspace folders. When working across multiple projects, the agent only sees the single working directory in the `<env>` block.

**Solution:** Store VS Code workspace folder paths in session data and inject them into the `<env>` block. Also auto-allow workspace folder paths for `external_directory` permission.

**System prompt output (multi-folder example):**
```
<env>
  Working directory: /Users/oleksii.honchar/www/misc/better-opencode
  VS Code workspace folders: /Users/oleksii.honchar/www/misc/better-openchamber, /Users/oleksii.honchar/www/misc/better-opencode
</env>
```

**Side effect:** Paths inside VS Code workspace folders are auto-allowed for `external_directory` permission — no agent-level rules needed.

---

## 12. TUI Worker GlobalBus Listener Cleanup

📋 [Detailed Spec](./spec/11-tui-worker-globalbus-listener-cleanup.md)

**Status:** ⏳ Pending

**Problem:** The TUI worker attaches a `GlobalBus.on("event", handler)` listener at module scope that is never removed. The `shutdown()` method disposes instances but does not clean up the GlobalBus listener, causing listener accumulation across reload/stop cycles. After 11 calls, `MaxListenersExceededWarning` is triggered.

**Solution:** Extract the anonymous handler to a named function, export a `removeGlobalEventListener()` cleanup function, and call it during `shutdown()`. Add `setMaxListeners(50)` on GlobalBus as a safety net.

**Root cause:** Module-scoped `GlobalBus.on("event", handler)` in `cli/cmd/tui/worker.ts:43` — no corresponding `off()`.

**Components:**
- **`cli/cmd/tui/worker.ts`** — Named handler function, `removeGlobalEventListener()` export, cleanup in `shutdown()`
- **`bus/global.ts`** — `setMaxListeners(50)` safety net
- **`server/global-lifecycle.ts`** — No changes (already correct)
- **`handlers/global.ts`** — No changes (already uses `acquireRelease` pattern)

---

## 13. SQLite Database Cleanup — PRAGMA, CLI & Background WAL

📋 [Detailed Spec](./spec/15-opencode-db-cleanup.md)

**Status:** ✅ Implemented

**Problem:** The opencode SQLite session database grows to ~1GB with no automated maintenance. The `part` table (333K rows, ~774 MB) stores all tool call outputs permanently. WAL checkpoint runs only at startup (PASSIVE mode). No VACUUM, no `journal_size_limit`, no session archival. Sustains 20-30 MB/s SSD writes during active sessions.

**Solution:** Four-part cleanup feature:

1. **DB Layer PRAGMA** (`storage/db.ts`) — `PRAGMA journal_size_limit = 16777216` (16MB WAL cap) added during initialization.

2. **DB CLI Commands** (`cli/cmd/db.ts`):
   - `opencode db vacuum` — VACUUM + checkpoint (TRUNCATE), prints freed space
   - `opencode db checkpoint` — Manual `PRAGMA wal_checkpoint(TRUNCATE)` for WAL trimming
   - `opencode db compact [--older-than 90d] [--dry-run]` — Deletes compacted parts + old tool parts, VACUUM, TRUNCATE
   - `opencode db stats` — DB size, WAL size, free pages, row counts, VACUUM recommendation

3. **Session Cleanup CLI** (`cli/cmd/session.ts`) — `opencode session cleanup [--older-than 90d] [--dry-run]` archives then cascade-deletes old sessions via Drizzle FK.

4. **Background WAL Checkpoint Loop** (`storage/db.ts`) — `startWalCheckpointLoop()` runs every 10 minutes, checkpoints (TRUNCATE) if WAL > 16MB. Safely disabled via `OPENCODE_DB_NO_AUTO_CHECKPOINT=1`.

**Key design decisions (5 ADRs):**
- Hybrid approach (CLI + Background) — destructive ops CLI-only, WAL checkpoint safe for background
- Reuses existing `time_archived` + Drizzle `onDelete: cascade` — zero schema change
- `PRAGMA wal_checkpoint(TRUNCATE)` over `PASSIVE` — truncates WAL to zero; auto-fallback to PASSIVE if busy
- `journal_size_limit` over `auto_vacuum` — zero runtime cost, no fragmentation; VACUUM for full reclamation
- Age-based tool output deletion (compacted parts + >90d threshold) — max space recovery, recent sessions pristine

---

## 14. Agent Model `:variant` Parsing

📋 [Detailed Spec](./spec/16-agent-model-variant-parsing.md)

**Status:** ✅ Implemented

**Problem:** The `variant:` config field is the only way to set a thinking variant for an agent's model. Users cannot specify a variant inline with the model string, forcing separate `variant:` declarations per agent.

**Solution:** Extend `Provider.parseModel()` to extract an optional `:variant` suffix from the model string. For example, `codex/gpt-5.5:medium` parses into `{ providerID: "codex", modelID: "gpt-5.5", variant: "medium" }`. The `:variant` is optional — `codex/gpt-5.5` (no variant) continues to work unchanged.

The variant is propagated through agent state construction, `resolveAgentModel`, and ACP `parseModelSelection`. It works for both the `model:` field (single model) and `models[]` array entries (per-entry variant).

**Variant precedence (highest to lowest):**
1. Inline `:variant` from matched `models[]` entry
2. Inline `:variant` from `model` string
3. Explicit `variant` field in agent config
4. Previously set `item.variant` (defaults, parent override, inheritance)

**Agent config examples:**

Single model:
```yaml
model: codex/gpt-5.5:medium
```

Multi-model with per-entry variants:
```yaml
models:
  - codex/gpt-5.5:medium
  - openrouter/claude:high
```

**Key design decisions (5 ADRs):**
- Extend `parseModel` return type — not a separate wrapper function (ADR-0027)
- Inline `:variant` beats config-level `variant` (ADR-0028)
- `:` as separator — unambiguous vs `/` in model IDs like `openrouter/anthropic/claude` (ADR-0029)
- Per-entry variant in `models[]` array, not Phase 2 deferral (ADR-0030)
- Pure parser — variant validation stays downstream (ADR-0031)

---

## 15. Tool Execution Logging — `tools.log`

**Status:** ✅ Implemented

**Problem:** There is no audit trail of what tools the agent called, with what arguments, and what the results were. Debugging agentic behavior is difficult because raw tool arguments are never persisted, outputs are only in chat history, and there is no structured log of the full tool execution lifecycle.

**Solution:** Introduce a `tools.log` JSON Lines file that captures the full lifecycle of every tool execution (built-in and MCP). Gated by the opt-in environment variable `OPENCODE_LOG_TOOLS=1`.

### ⚠️ Privacy & Security Warning

**`tools.log` captures full tool arguments and outputs, which may contain sensitive data including:**

- File contents (paths, code, credentials, tokens)
- Shell command outputs (environment variables, system information)
- API responses from MCP servers
- User messages and session data

**Do not enable `OPENCODE_LOG_TOOLS` in production or on systems with sensitive data unless you understand the privacy implications.** The feature is opt-in and disabled by default. When enabled, the log file is written to disk in plain text — anyone with file access can read it. Rotate and clean up logs regularly.

### How to Enable

```bash
export OPENCODE_LOG_TOOLS=1
opencode
```

Or inline:

```bash
OPENCODE_LOG_TOOLS=1 opencode
```

### Log File Location

The log file is written to the opencode global log directory:

```
<Global.Path.log>/tools.log
```

Typical paths:
- macOS/Linux: `~/.opencode/log/tools.log`
- Windows: `%USERPROFILE%\.opencode\log\tools.log`

### Rotation

The log file uses numeric rotation with 5 backups:

```
tools.log        ← current (truncated on rotation)
tools-1.log      ← previous
tools-2.log      ← older
tools-3.log
tools-4.log
tools-5.log      ← oldest (dropped on next rotation)
```

Rotation occurs on process start. The current `tools.log` is truncated, and older files are shifted numerically.

### JSON Schema — Log Entry Fields

Each line is a single JSON object with the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `timestamp` | `string` (ISO 8601) | Yes | When the log line was written |
| `tool` | `string` | Yes | Tool ID (e.g., `shell`, `mcp:filesystem:read`) |
| `sessionId` | `string` | Yes | Session ID (e.g., `ses_abc123`) |
| `messageId` | `string` | Yes | Message ID (e.g., `msg_xyz`) |
| `callId` | `string \| null` | Yes | Tool call ID (`null` if absent) |
| `durationMs` | `number` | Yes | Wall-clock duration in milliseconds |
| `args` | `object` | Yes | Decoded args (built-in) or raw args (MCP) |
| `output` | `string` | No | Truncated output (omitted on error) |
| `truncated` | `boolean` | No | Whether output was truncated |
| `rawOutputLength` | `number` | No | Original output length when truncated |
| `error` | `string` | No | Error message (omitted on success) |
| `source` | `"built-in" \| "mcp"` | Yes | Origin of the tool |

### Example Log Entries

**Successful built-in tool call:**
```json
{"timestamp":"2026-07-12T12:51:00.123Z","tool":"shell","sessionId":"ses_abc","messageId":"msg_123","callId":"call_456","durationMs":842,"args":{"command":"ls","cwd":"/home/user"},"output":"file1.txt\nfile2.txt","truncated":false,"source":"built-in"}
```

**Successful MCP tool call:**
```json
{"timestamp":"2026-07-12T12:51:01.456Z","tool":"mcp:filesystem:read","sessionId":"ses_abc","messageId":"msg_123","callId":"call_789","durationMs":1205,"args":{"path":"/etc/hosts"},"output":"127.0.0.1 localhost","truncated":false,"source":"mcp"}
```

**Error — tool execution failed:**
```json
{"timestamp":"2026-07-12T12:51:02.789Z","tool":"shell","sessionId":"ses_abc","messageId":"msg_123","callId":"call_012","durationMs":15,"args":{"command":"invalid"},"error":"Command not found: invalid","source":"built-in"}
```

**Truncated output (raw output exceeded limit):**
```json
{"timestamp":"2026-07-12T12:51:03.000Z","tool":"shell","sessionId":"ses_abc","messageId":"msg_123","callId":"call_345","durationMs":3200,"args":{"command":"cat large-file.txt"},"output":"...truncated...","truncated":true,"rawOutputLength":524288,"source":"built-in"}
```

### Querying `tools.log` with `jq`

Since `tools.log` is a JSON Lines file, use `jq -c` (compact) or `jq -r` (raw) to query it:

**Filter by tool name:**
```bash
jq -c 'select(.tool == "shell")' ~/.opencode/log/tools.log
```

**Filter by session:**
```bash
jq -c 'select(.sessionId == "ses_abc")' ~/.opencode/log/tools.log
```

**Show only errors:**
```bash
jq -c 'select(.error != null)' ~/.opencode/log/tools.log
```

**Show only truncated outputs:**
```bash
jq -c 'select(.truncated == true)' ~/.opencode/log/tools.log
```

**Show slow tool calls (> 5 seconds):**
```bash
jq -c 'select(.durationMs > 5000)' ~/.opencode/log/tools.log
```

**Show only MCP tools:**
```bash
jq -c 'select(.source == "mcp")' ~/.opencode/log/tools.log
```

**Extract tool names and durations (summary):**
```bash
jq -r '[.tool, (.durationMs | tostring)] | join("\t")' ~/.opencode/log/tools.log | sort -k1 | uniq -c | sort -rn
```

**Show error messages with context:**
```bash
jq -r 'select(.error != null) | "✗ \(.tool) [\(.durationMs)ms]: \(.error)"' ~/.opencode/log/tools.log
```

**Count tool calls per session:**
```bash
jq -r '.sessionId' ~/.opencode/log/tools.log | sort | uniq -c | sort -rn
```

### Performance

When `OPENCODE_LOG_TOOLS` is not set (or not `"1"`), the `toolsLog` function is a no-op — there is zero overhead per tool call. The environment variable is cached at module load time; no per-call check is performed.

When enabled, writes are fire-and-forget (best-effort). An unclean process exit may drop the last buffered line(s), which is acceptable for a debugging aid.

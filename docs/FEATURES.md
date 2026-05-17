# better-opencode Features

This document describes the nine features added by the `better-opencode` fork.

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

📋 [Detailed Spec](./spec/09-agent-llm-params-per-agent.md)

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

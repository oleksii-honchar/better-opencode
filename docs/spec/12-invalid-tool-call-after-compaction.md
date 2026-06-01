---
feature: invalid-tool-call-after-compaction
version: 1.0.0
status: implemented
source: session 260601-1447-chat-tool-invalid
pr: N/A
implementation: done
---

# Spec: Fix "Invalid" Tool Call After Chat Compaction

## Problem Statement

In the chat interface, bash tool calls display **"invalid"** instead of executing after multiple chat compactions. The root cause is **AI SDK schema validation failures** on tool call arguments — most commonly a missing required `description` field. Chat compaction strips away the LLM's in-context examples of properly formatted tool calls, increasing the likelihood of schema violations.

**Symptom:** A bash tool call shows "invalid" (✗) instead of executing.

**Root cause:** The LLM generates a tool call missing the required `description` field after compaction. The `experimental_repairToolCall` callback cannot repair schema errors (only case mismatches), so it silently converts the call to `toolName: "invalid"` with zero logging.

**Red herring:** The `error TS5058: The specified path does not exist` message — the command never reached execution; it failed schema validation first.

## Solution

Four targeted changes across existing components:

### 1. Make `description` Optional (Schema Relaxation)

**File:** `packages/opencode/src/tool/shell/prompt.ts`

The `description` field is UI metadata, not functionally required for command execution. Making it optional eliminates the #1 cause of post-compaction invalid tool calls.

```typescript
// BEFORE
description: Schema.String.annotate({ description }),

// AFTER
description: Schema.optionalWith(Schema.String, {
  default: () => "",
}).annotate({ description }),
```

**Auto-generation:** In `packages/opencode/src/tool/shell.ts`, if `description` is empty, auto-generate from the first 10 words (or first 80 chars) of the command:

```typescript
const description = params.description
  ? params.description
  : params.command.split(/\s+/).slice(0, 10).join(" ").slice(0, 80)
```

### 2. Add Structured Logging to Repair Callback

**File:** `packages/opencode/src/session/llm.ts`

The `experimental_repairToolCall` callback had asymmetric logging — it logged case-mismatch repairs but **nothing** when converting to `invalid`. Added `l.warn` in the invalid path:

```typescript
l.warn("tool call validation failed, converting to invalid", {
  tool: failed.toolCall.toolName,
  error: failed.error.message,
  args: failed.toolCall.args,
})
```

### 3. Enrich `InvalidTool` Output with Schema Hints

**File:** `packages/opencode/src/tool/invalid.ts`

The generic error message did not help the LLM self-correct. Now includes required field reminders:

```
The arguments provided to the tool are invalid: Missing required field: description

Please ensure your tool call includes all required fields.
For bash: { "command": "...", "description": "..." }
For edit: { "filePath": "...", "oldString": "...", "newString": "..." }
For write: { "filePath": "...", "content": "..." }
```

### 4. Add Tool Format Reminder to System Prompt

**File:** `packages/opencode/src/session/prompt/default.txt`

A static reminder in the system prompt survives compaction (unlike conversation history):

```markdown
# Tool Call Format

When calling tools, always include all required fields:
- bash: command (string), description (string, 5-10 words)
- edit: filePath (string), oldString (string), newString (string)
- write: filePath (string), content (string)
```

## Impact

- **Positive:** Bash tool calls succeed even when LLM omits `description` after compaction
- **Positive:** Every invalid tool conversion is now traceable via logs
- **Positive:** LLM can self-correct after a single invalid tool call
- **Positive:** Proactive prevention via system prompt reminder
- **Risk (low):** Tool titles may occasionally be generic (auto-generated from command)

## Deferred

- **Phase 3:** Pre-flight tool call validation with auto-injection of missing fields
- **Phase 3:** Preserve recent N tool call examples across compaction

---
feature: tool-execute-after-inject
version: 1.0.0
status: spec
source: architect/spec.md (Patch 1, PR #19519)
pr: anomalyco/opencode#19519
implementation: pending
---

# Spec: tool.execute.after inject

## Implementation Status

| Status | Description |
|--------|-------------|
| **Status** | ⏳ **Pending** — Not yet implemented |
| **Source** | PR #19519 (unmerged upstream) |
| **PR Ref** | `pr-19519` (local branch) |
| **Next Step** | Cherry-pick from PR ref or manually apply |

## Problem Statement

Plugins cannot inject synthetic user messages after tool execution. These messages would be visible to the AI on the next loop iteration, enabling behavioral enforcement patterns like "remember to update progress.md after every edit."

## Design Decision

**The `inject` field is added to the `output` of `tool.execute.after` hook.**

**Rationale:**
- Minimal change to existing hook interface
- Injected messages are persisted and visible after compaction
- System-role injections are wrapped in `<system-reminder>` tags
- Messages are marked with `synthetic: true`

## Files Modified

| File | Lines Added | Lines Removed |
|------|-------------|---------------|
| `packages/plugin/src/index.ts` | +12 | 0 |
| `packages/opencode/src/session/prompt.ts` | ~50 | 0 |

## Implementation Details

### 1. `packages/plugin/src/index.ts` — Add inject type to hook output

**Location:** Lines 273-280

```typescript
// Before
"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: {
    title: string
    output: string
    metadata: any
  },
) => Promise<void>

// After
"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: {
    title: string
    output: string
    metadata: any
    /** Messages to inject into the conversation after this tool call. */
    inject?: Array<{ role: "user" | "system"; text: string }>
  },
) => Promise<void>
```

### 2. `packages/opencode/src/session/prompt.ts` — Add flushInjectedMessages() and call sites

**Add helper function** (near other message flush helpers):

```typescript
/**
 * Flush any synthetic user messages injected by tool.execute.after hooks.
 * These messages are persisted and visible to the AI on the next loop iteration.
 */
function flushInjectedMessages(
  injected: Array<{ role: "user" | "system"; text: string }>,
  msgs: Array<{ info: Message; parts: Part[] }>,
) {
  if (injected.length === 0) return
  for (const injection of injected) {
    const isSystem = injection.role === "system"
    const wrapped = isSystem
      ? `<system-reminder>${injection.text}</system-reminder>`
      : injection.text
    msgs.push({
      info: {
        role: "user",
        type: "text",
        content: wrapped,
        synthetic: true,
      },
      parts: [{ type: "text", text: wrapped }],
    })
  }
}
```

**Add call sites** at three locations where `tool.execute.after` hooks are triggered:

1. **Registry tools** (line ~433)
2. **MCP tools** (line ~468)
3. **Subtask tools** (line ~660)

After each hook invocation:

```typescript
// Collect injected messages
const injected: Array<{ role: "user" | "system"; text: string }> = []
// ... hook invocation code ...
if (output.inject) {
  injected.push(...output.inject)
}
// ... after all hooks for this tool ...
if (injected.length > 0) {
  flushInjectedMessages(injected, msgs)
}
```

## Plugin Usage Example

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

## OpenChamber Impact Assessment

| File | Change Type | Impact |
|------|-------------|--------|
| `packages/plugin/src/index.ts` | Optional field added to hook output | **None** — optional field is backward-compatible |
| `packages/opencode/src/session/prompt.ts` | Internal tool execution logic | **None** — not exported |

**Risk Level:** Very Low

## Success Criteria

- [ ] Plugin can return `output.inject` from `tool.execute.after`
- [ ] Injected messages appear in conversation on next loop iteration
- [ ] Injected messages survive session compaction
- [ ] System-role injections are wrapped in `<system-reminder>` tags
- [ ] OpenChamber type-check passes
- [ ] OpenChamber build succeeds

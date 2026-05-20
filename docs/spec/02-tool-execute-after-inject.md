---
feature: tool-execute-after-inject
version: 1.0.0
status: implemented
source: architect/spec.md (Patch 1, PR #19519)
pr: anomalyco/opencode#19519
implementation: done
implementedAt: "2026-05-20"
reviewedAt: "2026-05-20"
---

# Spec: tool.execute.after inject

## Implementation Status

| Status | Description |
|--------|-------------|
| **Status** | ✅ **Implemented** — Feature complete, reviewed, typecheck + build pass |
| **Source** | PR #19519 (unmerged upstream) |
| **Implemented** | 2026-05-20 |
| **Review** | Approved with 2 low-severity comments (no blockers) |

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
| `packages/plugin/src/index.ts` | +3 | 0 |
| `packages/opencode/src/session/prompt.ts` | ~60 | 0 |

## Implementation Details

### Architect Corrections

The original spec proposed pushing synthetic messages to the in-memory `msgs` array. This was corrected during planning: **messages must be persisted via `sessions.updateMessage` + `sessions.updatePart`** to survive session compaction (compaction reads from the database, not the in-memory array). This follows the pattern used by all other synthetic messages in the codebase (e.g., subtask summary injection at L890-905).

Additionally:
- Line numbers corrected: actual call sites are **L611** (registry), **L655** (MCP), **L847** (subtask) — not ~433/~468/~660
- Collection pattern simplified: just check `output.inject` after `plugin.trigger` (no separate collection array needed)
- `flushInjectedMessages` is an **Effect generator** (`Effect.fn`) since it calls `sessions.updatePart`

### 1. `packages/plugin/src/index.ts` — Add inject type to hook output

**Location:** Lines 273-282

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

**Add Effect helper** (near other message helpers):

```typescript
const flushInjectedMessages = Effect.fn("flushInjectedMessages")(function* (input: {
  injected: Array<{ role: "user" | "system"; text: string }>
  sessionID: string
  agent: string
  providerID: string
  modelID: string
}) {
  if (input.injected.length === 0) return
  for (const injection of input.injected) {
    const isSystem = injection.role === "system"
    const wrapped = isSystem
      ? `<system-reminder>${injection.text}</system-reminder>`
      : injection.text

    // Persist synthetic message to database (survives compaction)
    const syntheticMsg = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.agent,
      model: input.modelID,
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: syntheticMsg.id,
      sessionID: input.sessionID,
      type: "text",
      text: wrapped,
      synthetic: true,
    })
  }
})
```

**Add call sites** at three locations where `tool.execute.after` hooks are triggered:

1. **Registry tools** (line ~611)
2. **MCP tools** (line ~655)
3. **Subtask tools** (line ~847)

After each hook invocation:

```typescript
const hookOutput = yield* plugin.trigger(
  "tool.execute.after",
  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
  output,
)
if (hookOutput?.inject) {
  yield* flushInjectedMessages({
    injected: hookOutput.inject,
    sessionID: ctx.sessionID,
    agent: input.agent.name,
    providerID: input.model.providerID,
    modelID: ModelID.make(input.model.api.id),
  })
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

- [x] Plugin can return `output.inject` from `tool.execute.after`
- [x] Injected messages appear in conversation on next loop iteration
- [x] Injected messages survive session compaction
- [x] System-role injections are wrapped in `<system-reminder>` tags
- [x] OpenChamber type-check passes
- [x] OpenChamber build succeeds

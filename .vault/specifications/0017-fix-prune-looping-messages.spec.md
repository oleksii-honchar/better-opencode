---
type: specification
title: "Fix pruneLoopingMessages to Preserve Tool-Call/Tool-Result Pairs"
kind: refactor
status: accepted
createdAt: "2026-08-13T18:00:00Z"
updatedAt: "2026-08-13T18:00:00Z"
tags: [tool-calls, prune, unstuck, loop-detection, orphan, bugfix]
owner: ""
target: "2026-08-13"
see_also:
  - "adrs/0078-fix-prune-preserve-pairs.adr.md"
  - "adrs/0075-fix-at-assembly-layer.adr.md"
  - "memories/0017-prune-looping-messages-orphan.memory.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Specification: Fix pruneLoopingMessages to Preserve Tool-Call/Tool-Result Pairs

## Goal

Fix the root cause of the codex "No tool call found for function call output" error by modifying `pruneLoopingMessages` in `packages/opencode/src/plugin/unstuck/wrapper.ts` to preserve tool-call/tool-result pairs when pruning assistant messages during loop detection.

## Root Cause

The `pruneLoopingMessages` function collects indices of all assistant messages, takes the last N (where N = pruneCount), and filters them out. It does not inspect message content or consider tool-call/tool-result pairs. When an assistant message with a tool-call part is pruned, the corresponding tool-result part in a subsequent tool message becomes orphaned.

This was identified by the second researcher investigation (session ses_005a1baf5ffesfeT1KO5OoBBT5) as the actual root cause, correcting the earlier hypothesis that the bug was in `MessageV2.toModelMessagesEffect`.

## Solution

Modify `pruneLoopingMessages` to:
1. Collect tool-call IDs from assistant messages being pruned.
2. Also prune any tool messages whose tool-result parts reference those tool-call IDs.
3. Filter out both assistant and tool messages.

## Component

### Fix pruneLoopingMessages

**File:** `packages/opencode/src/plugin/unstuck/wrapper.ts`

**Location:** `pruneLoopingMessages()` function (lines 50-66), invoked at line 415.

**Behavior:**
- Collect indices of assistant messages to prune (unchanged).
- Collect tool-call IDs from pruned assistant messages (new).
- Collect indices of tool messages to prune based on tool-call IDs (new).
- Filter out both assistant and tool messages (changed).

**Implementation sketch** (from findings):

```typescript
function pruneLoopingMessages(
  messages: Message[],
  pruneCount: number,
): Message[] {
  // Collect indices of assistant messages to prune
  const assistantIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      assistantIndices.push(i)
    }
  }

  const toRemove = Math.min(pruneCount, assistantIndices.length)
  const assistantIndicesToRemove = new Set(assistantIndices.slice(-toRemove))

  // Collect tool-call IDs from pruned assistant messages
  const prunedToolCallIds = new Set<string>()
  for (const idx of assistantIndicesToRemove) {
    const msg = messages[idx]
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "tool-call" && part.toolCallId) {
          prunedToolCallIds.add(part.toolCallId)
        }
      }
    }
  }

  // Collect indices of tool messages to prune
  const toolIndicesToRemove = new Set<number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-result" && part.toolCallId && prunedToolCallIds.has(part.toolCallId)) {
        toolIndicesToRemove.add(i)
        break
      }
    }
  }

  // Filter out both assistant and tool messages
  const indicesToRemove = new Set([...assistantIndicesToRemove, ...toolIndicesToRemove])
  return messages.filter((_, i) => !indicesToRemove.has(i))
}
```

**Tests:** Add tests to `packages/opencode/src/plugin/unstuck/wrapper.test.ts` covering:
- Pruning assistant messages with tool-call parts also prunes corresponding tool messages.
- Pruning assistant messages without tool-call parts does not affect tool messages.
- Pruning multiple assistant messages with mixed tool-call/non-tool-call parts.
- Pruning assistant messages with multiple tool-call parts.

## Data Models

No new data models. The fix operates on existing AI SDK types:
- `Message`: `{ role: "assistant" | "tool" | ...; content: Part[] }`
- `ToolCallPart`: `{ type: "tool-call"; toolCallId: string; ... }`
- `ToolResultPart`: `{ type: "tool-result"; toolCallId: string; ... }`

## Technology Stack

No new dependencies. The fix uses existing packages.

## Implementation Plan

### Phase 1: Fix pruneLoopingMessages

1. Modify `pruneLoopingMessages` in `packages/opencode/src/plugin/unstuck/wrapper.ts` to collect tool-call IDs from pruned assistant messages and prune corresponding tool messages.
2. Add tests to `packages/opencode/src/plugin/unstuck/wrapper.test.ts` covering tool-call/tool-result pair pruning.
3. Run targeted tests: `bun test packages/opencode/src/plugin/unstuck/wrapper.test.ts`.
4. Run typecheck: `bun turbo typecheck`.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Prune function incorrectly prunes non-orphaned tool messages | LOW | Prune logic is deterministic and covered by unit tests. |
| Performance impact | LOW | O(n) per prune operation, where n = number of messages. Negligible overhead. |

## Impact Analysis

The fix modifies only `packages/opencode/src/plugin/unstuck/wrapper.ts`, specifically the `pruneLoopingMessages` function. This function is called only during the nudge-and-prune loop detection strategy in the unstuck plugin wrapper.

No existing functionality is affected. The fix is additive and backward-compatible.

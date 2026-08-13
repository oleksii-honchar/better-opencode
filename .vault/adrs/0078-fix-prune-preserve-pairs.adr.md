---
type: adr
id: ADR-0078
title: "Fix pruneLoopingMessages to Preserve Tool-Call/Tool-Result Pairs"
status: accepted
createdAt: "2026-08-13T18:00:00Z"
updatedAt: "2026-08-13T18:00:00Z"
tags: [tool-calls, prune, unstuck, loop-detection, orphan, message-integrity]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0075-fix-at-assembly-layer.adr.md"
  - "adrs/0076-drop-orphan-tool-results.adr.md"
  - "adrs/0077-defense-in-depth-validate-messages.adr.md"
  - "specifications/0017-fix-prune-looping-messages.spec.md"
  - "memories/0017-prune-looping-messages-orphan.memory.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0078: Fix pruneLoopingMessages to Preserve Tool-Call/Tool-Result Pairs

## Context

The `pruneLoopingMessages` function in `packages/opencode/src/plugin/unstuck/wrapper.ts` is the **actual root cause** of the codex "No tool call found for function call output" error and the DeepSeek "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'" error.

This function is part of the nudge-and-prune loop detection strategy (introduced in commit `5d0a703cc5`). When a loop is detected, it:
1. Collects indices of all assistant messages
2. Takes the last N indices (where N = pruneCount)
3. Filters them out

It does **not** inspect message content or consider tool-call/tool-result pairs. When an assistant message with a tool-call part is pruned, the corresponding tool-result part in a subsequent tool message becomes orphaned.

The earlier hypothesis (ADR-0075) that the bug lived in `MessageV2.toModelMessagesEffect` was disproved by a second researcher investigation. The repair layer at `message-v2.ts` (ADR-0076/0077) works as defense-in-depth but does not fix the source.

## Decision

Fix `pruneLoopingMessages` to collect tool-call IDs from pruned assistant messages and also prune any tool messages whose tool-result parts reference those tool-call IDs. This prevents the issue at the source.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Fix pruneLoopingMessages to preserve pairs | Fixes root cause; prevents orphans at source | Modifies prune function logic | — |
| Only use the repair layer (ADR-0076/0077) | Already implemented; catches orphans downstream | Fixes symptom, not cause; prune function remains broken | Doesn't address root cause |

## Consequences

- **Positive:** The prune function no longer creates orphaned tool-results; the repair layer at `message-v2.ts` becomes a safety net rather than the primary fix.
- **Positive:** The prune function logic is straightforward and well-defined; tool-call IDs are explicitly tracked.
- **Negative:** The prune function is slightly more complex (O(n) additional pass to collect tool-call IDs and match tool messages). Negligible overhead.
- **Neutral:** The repair layer from ADR-0076/0077 can remain in place as defense-in-depth for other potential sources of orphaned tool-results.

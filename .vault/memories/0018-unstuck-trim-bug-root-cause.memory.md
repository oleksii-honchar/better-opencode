---
type: memory
title: "Unstuck Plugin: Commit 04c1e08c78 Extended Pruning to Tool-Result Messages"
createdAt: "2026-08-14T13:00:00Z"
updatedAt: "2026-08-14T13:00:00Z"
tags: [unstuck, prune, tool-calls, regression, context-integrity]
see_also:
  - "adrs/0080-nudge-only-intervention.adr.md"
  - "adrs/0078-fix-prune-preserve-pairs.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: Unstuck Plugin: Commit 04c1e08c78 Extended Pruning to Tool-Result Messages

## Fact

Commit `04c1e08c78` ("feat(unstuck): export and enhance pruneLoopingMessages to remove tool-result messages", dated Thu Aug 13 2026) extended `pruneLoopingMessages` in `packages/opencode/src/plugin/unstuck/wrapper.ts` to not only remove the last N assistant messages but also remove any tool-result messages whose tool-call IDs matched the pruned assistant messages.

Before this commit, only assistant messages were pruned — tool-result messages remained orphaned, caught by the defense-in-depth repair layer at `message-v2.ts`. After this commit, the entire assistant+tool-result pair is removed, causing the LLM to lose its working history of tool invocations.

## Context

The unstuck plugin's default strategy was `"nudge-and-prune"`. When a loop was detected, `pruneLoopingMessages` was called on the full prompt, then a nudge message was appended to the pruned prompt, and the stream was restarted with the modified conversation. The `pruneCount` default was 3, and `maxNudges` was 10 — meaning up to 10 successive nudge restarts, each potentially shrinking the prompt further.

## Impact

Two symptoms: (1) context length fluctuation across nudge restarts, and (2) the agent losing track of its own tool history because tool-call + tool-result pairs were silently removed from the prompt. The second symptom is the critical one — the model literally cannot reason about actions it no longer has in context. This was the direct cause of the reported "agent being lost" regression.

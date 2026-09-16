---
type: specification
title: "Fix Post-Compaction Recall Race Condition"
id: SPEC-0023
kind: bugfix
status: completed
createdAt: "2026-09-16"
updatedAt: "2026-09-16"
tags: [compaction, recall, plugin, race-condition, bensyne]
system: opencode
see_also:
  - [[0107-sequential-post-compaction-recall.adr.md]]
---

## Goal

Fix the race condition where the post-compaction recall prompt is sent asynchronously (via `Effect.forkDetach`), causing the OpenAI API error "Cannot have 2 or more assistant messages at the end of the list." Send the recall prompt synchronously after compaction completes, ensuring correct message ordering.

## Root Cause

The `postCompactionRecall` hook was forked asynchronously after the compaction process completed. The recall prompt was sent via `session.prompt()` (HTTP request) and queued on the server. Meanwhile, the compaction summary (an assistant message) was written to the conversation history. When the server processed the queued recall prompt, the conversation history ended with two consecutive assistant messages (compaction summary + pending response), causing the API error.

The OpenAI API validates the conversation before processing and throws: "Cannot have 2 or more assistant messages at the end of the list." The session then exited immediately without processing the recall prompt, so the agent never recalled its traversal history.

## Phases

### Phase 1: Fix postCompactionRecall to be synchronous

- **Location:** `packages/opencode/src/session/compaction.ts` (lines 687-693)
- **Change:** Replace `Effect.forkDetach` with direct invocation for `postCompactionRecall`.
- **Note:** Keep `postCompactionRestore` forked (unchanged) — it's independent of the recall sequence.

### Phase 2: Add self-reflect decision tree branches to all 15 agents

- **Location:** `agents/bensyne-personas/agent-personas/*`
- **Change:** Add post-compaction self-reflect branches to all 15 agent decision trees to ensure they recall their traversal history after compaction.
- **Purpose:** Defense-in-depth against future race conditions; ensures agents always re-orient after context compaction.

## Affected Code

- `packages/opencode/src/session/compaction.ts` — Primary fix location
- `packages/opencode/src/plugin/bensyne/index.ts` — No changes required
- `packages/opencode/src/plugin/index.ts` — No changes required
- `agents/bensyne-personas/agent-personas/*` — Self-reflect decision tree branches (15 agents)

## Acceptance Criteria

- [x] The `postCompactionRecall` call is synchronous (no `Effect.forkDetach`)
- [x] The `postCompactionRestore` call remains forked (unchanged)
- [x] Code compiles without type errors
- [x] No regression in existing compaction tests
- [x] Manual verification: post-compaction recall works correctly (no API error)
- [x] All 15 agents have self-reflect decision tree branches

## Test Strategy

1. Run targeted compaction test: `bun test packages/opencode/src/session/compaction.test.ts`
2. Run typecheck: `bun turbo typecheck`
3. Manual verification: trigger compaction and confirm recall prompt is processed successfully

## Risks

- **Low risk:** Making recall synchronous slightly increases compaction latency (adds one HTTP round-trip). Acceptable for correctness.

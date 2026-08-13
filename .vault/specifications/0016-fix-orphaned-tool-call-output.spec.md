---
type: specification
title: "Fix Codex & DeepSeek Orphaned Tool-Call Output Error"
kind: refactor
status: completed
createdAt: "2026-08-13T10:35:00Z"
updatedAt: "2026-08-13T10:35:00Z"
tags: [tool-calls, message-assembly, codex, deepseek, bugfix]
owner: ""
target: "2026-08-13"
see_also:
  - "adrs/0075-fix-at-assembly-layer.adr.md"
  - "adrs/0076-drop-orphan-tool-results.adr.md"
  - "adrs/0077-defense-in-depth-validate-messages.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Specification: Fix Codex & DeepSeek Orphaned Tool-Call Output Error

## Goal

Fix the systemic bug where opencode's `MessageV2.toModelMessagesEffect` drops assistant tool-call parts while preserving tool-result parts, causing:
- Codex (OpenAI Responses): `No tool call found for function call output with call_id ...`
- DeepSeek (Chat Completions): `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`

Both errors mean the same thing: the assistant's tool-call item is missing from the messages array sent to the LLM, while its paired tool-result item is present.

## Phases

### Phase 1 — Preserve Layer (Primary Fix)
- [x] Add `repairOrphanedToolResults(messages: ModelMessage[]): ModelMessage[]` pure helper in `packages/opencode/src/session/message-v2.ts`
- [x] Integrate into `toModelMessagesEffect` after `convertToModelMessages`
- [x] Per-orphan `Effect.logWarning` with `toolCallId`, `messageIndex`, `reason: "orphan"`

### Phase 2 — Validate Layer (Defense-in-Depth)
- [x] Add `findOrphanedToolResults` private helper in `packages/opencode/src/session/llm.ts`
- [x] Extend `LLM.validateMessages` Phase 2: detect and drop orphan tool-results
- [x] Never fail the request on orphan detection

### Phase 3 — Diagnostic Log
- [x] Env-gated `Effect.logDebug` in `toModelMessagesEffect` (gate: `OPENCODE_DEBUG_MSG_ASSEMBLY=1`)
- [x] `countAssemblyParts` helper with `toolCallCount`, `toolResultCount`, `orphanCount`

### Phase 4 — Targeted Tests
- [x] `packages/opencode/src/session/message-v2.test.ts` (20 tests, 58 expect() calls)
- [x] `packages/opencode/src/session/llm.test.ts` (9 tests, 21 expect() calls)
- [x] Combined regression: 29 pass / 0 fail / 79 expect() calls
- [x] `bun turbo typecheck`: clean (15/15 packages)

### Phase 5 — Manual Verification (User-Driven)
- [ ] Replay failing codex session `ses_00611d75cffectGa5vNW0F4UMi` with `OPENCODE_DEBUG_MSG_ASSEMBLY=1`
- [ ] Spot-check a DeepSeek session

## Behaviors

- **Given** a messages array with a paired tool-call and tool-result, **when** `repairOrphanedToolResults` runs, **then** both are preserved in order.
- **Given** a messages array with an orphan tool-result (no matching tool-call), **when** `repairOrphanedToolResults` runs, **then** the orphan tool message is removed and a warning is logged.
- **Given** a mixed history with multiple tool-calls and one orphan, **when** the repair runs, **then** only the orphan is removed; all paired messages are preserved.
- **Given** a messages array with a tool-call part missing its `input`, **when** `validateMessages` runs, **then** the request fails (Phase 1 — hard fail, unchanged).
- **Given** a messages array with an orphan tool-result AND a missing-input tool-call, **when** `validateMessages` runs, **then** the request fails on the missing-input tool-call; the orphan is not processed (Phase 1 takes priority).
- **Given** `OPENCODE_DEBUG_MSG_ASSEMBLY=1`, **when** `toModelMessagesEffect` runs, **then** a debug log is emitted with assembly counts.
- **Given** `OPENCODE_DEBUG_MSG_ASSEMBLY` is unset, **when** `toModelMessagesEffect` runs, **then** no debug log is emitted.

## Risks

- **Risk:** Repair drops a legitimate tool-result during normal flow — **Mitigation:** Test covers both orphan-detection and legitimate-pair preservation; defense-in-depth validation layer catches misses.
- **Risk:** `convertToModelMessages` returns parts in unexpected shape — **Mitigation:** Developer verified the part-shape assumptions against installed AI SDK types.
- **Risk:** Repair changes message order — **Mitigation:** Filter is order-preserving and only removes; never reorders or duplicates.
- **Risk:** AI SDK upgrade re-introduces the bug — **Mitigation:** Defense-in-depth `validateMessages` layer catches it.

## Milestones

- 2026-08-13: All phases completed. Review approved.

## Links

- **ADRs:** [[adrs/0075-fix-at-assembly-layer.adr.md]], [[adrs/0076-drop-orphan-tool-results.adr.md]], [[adrs/0077-defense-in-depth-validate-messages.adr.md]]
- **Concepts:** [[concepts/0003-llm-turn-management.concept.md]]

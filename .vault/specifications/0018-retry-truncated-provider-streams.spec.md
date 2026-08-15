---
type: specification
title: "Retry Truncated Provider Streams — Fix Sub-Agent Abrupt Stop"
kind: bugfix
status: accepted
createdAt: "2026-08-15T11:30:00Z"
updatedAt: "2026-08-15T18:16:15Z"
tags: [subagent, task-tool, provider, stream, retry, bugfix]
owner: ""
target: "2026-08-15"
see_also:
  - "adrs/0090-retry-truncated-provider-streams.adr.md"
  - "memories/0019-subagent-abrupt-stop-workaround.memory.md"
  - "concepts/0004-subagent-delegation.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Specification: Retry Truncated Provider Streams — Fix Sub-Agent Abrupt Stop

## Goal

Fix the sub-agent abrupt-stop bug: a sub-agent launched via the `task` tool produces one message then stops on the first attempt, while a retry succeeds. Root cause is upstream anomalyco/opencode#37852 — a provider stream silently truncated and recorded as a clean stop (`finish=unknown`, zero usage, no text).

## Root Cause

Provider stream terminates mid-generation without a finish reason → AI SDK synthesizes `finishReason: "other"` with `rawFinishReason: undefined` → fork's `ai-sdk.ts` `finishReason()` maps it to `"unknown"` → runLoop exits as if the turn completed cleanly → `task.ts` returns an empty result (`findLast(...)?.text ?? ""`) with no `result.info.error` check → parent session sees an empty, silent failure. Transient by nature, so the retry succeeds — matching the observed first-fail/second-success pattern.

## Solution

Adopt upstream PR #39473 (4 changes):

1. **Detect truncated provider streams** — `packages/opencode/src/session/llm/ai-sdk.ts`, `toLLMEvents` `finish-step` case: throw `ProviderError.ResponseStreamError` when `event.finishReason === "other" && event.rawFinishReason === undefined`.
2. **Propagate child assistant errors** — `packages/opencode/src/tool/task.ts` `runTask()`: after `ops.prompt(...)`, fail the task if `result.info.role === "assistant" && result.info.error`.
3. **Add `ResponseStreamError` class** — `packages/opencode/src/provider/error.ts`: `class ResponseStreamError extends APICallError` with type `"response-stream-error"`.
4. **Mark retryable** — `packages/opencode/src/session/retry.ts`: `retryable()` returns `{ message: "Provider stream ended unexpectedly" }` for `response-stream-error`; max 2 retries, exponential backoff (100ms, 200ms).

## Component

### Detect Truncated Provider Streams

**File:** `packages/opencode/src/session/llm/ai-sdk.ts`

**Behavior:** In `toLLMEvents`, both `finish-step` and `finish` cases check for the truncated-stream signature and throw `ResponseStreamError` (retryable via existing retry machinery).

### Propagate Child Assistant Errors Through Task Tool

**File:** `packages/opencode/src/tool/task.ts`

**Behavior:** In `runTask()`, after `ops.prompt(...)`, check `result.info.error` and fail the task — retry exhaustion can no longer become an empty success.

## Data Models

No new data models. Error class addition only.

## Technology Stack

No new dependencies. Uses existing Effect + provider error infrastructure.

## Implementation Plan

### Phase 1: Add ResponseStreamError Class
Add class to `provider/error.ts`; export it.

### Phase 2: Detect Truncated Provider Streams
Add `finish-step`/`finish` checks in `ai-sdk.ts` throwing `ResponseStreamError`.

### Phase 3: Propagate Child Assistant Errors
Add `result.info.error` check in `task.ts` `runTask()`.

### Phase 4: Add Retry Logic
Mark `ResponseStreamError` retryable in `retry.ts`; add retry tests.

**Verification (targeted):** `bun test packages/opencode/src/session/llm/ai-sdk.test.ts`, `bun test packages/opencode/src/tool/task.test.ts`, `bun test packages/opencode/src/provider/error.test.ts`; `bun turbo typecheck`.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Retry logic masks underlying issues | MEDIUM | Limit to 2 retries; log all attempts |
| Logging overhead | LOW | INFO for detection, DEBUG for verbose |
| Error-handling regressions | LOW | Preserve existing error types/messages |

## Impact Analysis

Affected: TaskTool (HIGH), Prompt Service (MEDIUM), Run State Service (LOW), Runner (LOW). Agent Service and Session Service unchanged. Implemented in fork commit `87aa1b54ae`; verified in code 2026-08-15.

---
type: adr
id: ADR-0090
title: "Retry Truncated Provider Streams (Adopt Upstream PR #39473)"
status: accepted
createdAt: "2026-08-15T11:30:00Z"
updatedAt: "2026-08-15T18:16:15Z"
tags: [subagent, task-tool, provider, stream, retry, bugfix]
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0004-subagent-delegation.concept.md"
  - "../specifications/0018-retry-truncated-provider-streams.spec.md"
  - "../memories/0019-subagent-abrupt-stop-workaround.memory.md"
---

# ADR-0090: Retry Truncated Provider Streams (Adopt Upstream PR #39473)

## Context

Sub-agents launched via the `task` tool in `better-opencode` occasionally fail silently at the very beginning of execution: the sub-agent produces a single message and stops, the session is not persisted, no error surfaces to the parent session, and a second attempt succeeds. This matches upstream issue anomalyco/opencode#37852 exactly (verified OPEN 2026-08-15); the environment model `deepseek-v4-flash` is the model family named in that issue.

Root-cause mechanism:

1. Provider stream terminates mid-generation WITHOUT a finish reason.
2. AI SDK synthesizes `finishReason: "other"` with `rawFinishReason: undefined`.
3. `ai-sdk.ts` `finishReason()` mapped any non-schema value to `"unknown"`.
4. The runLoop exit condition treated `finish=unknown` as a clean completion.
5. `task.ts` returned `result.parts.findLast(...)?.text ?? ""` with no `result.info.error` check — empty result propagated to parent.

Upstream has an open, unmerged fix PR #39473 "fix: retry truncated provider streams" (verified OPEN 2026-08-15).

## Decision

Adopt the changes from upstream PR #39473:

1. **Detect truncated provider streams** — In `ai-sdk.ts` `toLLMEvents`, in the `finish-step` case, if `event.finishReason === "other" && event.rawFinishReason === undefined`, throw `ProviderError.ResponseStreamError("Provider stream ended without a finish reason")`.
2. **Propagate child assistant errors through task tool** — In `task.ts` `runTask()`, after `ops.prompt(...)`, if `result.info.role === "assistant" && result.info.error`, fail the task with `Effect.fail(new Error(result.info.error.name))` instead of returning an empty string.
3. **Add `ResponseStreamError` class** — In `provider/error.ts`, a retryable `APICallError` subclass with `data.type = "response-stream-error"`.
4. **Mark it retryable** — In `session/retry.ts`, `retryable()` returns `{ message: "Provider stream ended unexpectedly" }` for `response-stream-error`.
5. **Retry parameters** — Max retries 2; exponential backoff (100ms, 200ms); only `ResponseStreamError` transient failures.
6. **Logging** — INFO level for truncated-stream detection; fields: sessionID, agent, model, step count, state transitions, error messages; at `ai-sdk.ts`, `task.ts`, `retry.ts`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Wait for upstream PR #39473 merge | No fork divergence | PR open, no ETA | Unacceptable latency |
| Implement custom fix | Tailored | Upstream PR already tested by ~10 users | Reinventing tested solution |
| Full transactional session management | Strongest | Overkill for this bug | Out of proportion |

## Consequences

- **Positive:** sub-agent abrupt-stop fixed; aligns fork with upstream; transient provider drops auto-recover.
- **Negative:** small added delay (≤2 retries) and logging overhead on failed streams.
- **Neutral:** no API/data-model changes.
- **Status:** accepted — implemented in fork commit `87aa1b54ae`; verified in code 2026-08-15 (ai-sdk.ts:79-80,94-95; error.ts:204; task.ts:249-252; retry.ts:71-73; prompt.ts:1665).

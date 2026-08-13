---
type: adr
id: ADR-0075
title: "Fix Orphaned Tool-Call Output at the Assembly Layer, Not the Provider Adapter"
status: accepted
createdAt: "2026-08-13T10:35:00Z"
updatedAt: "2026-08-13T10:35:00Z"
tags: [tool-calls, message-assembly, provider, codex, deepseek]
supersedes: []
superseded_by: []
see_also:
  - "concepts/0003-llm-turn-management.concept.md"
  - "specifications/0016-fix-orphaned-tool-call-output.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0075: Fix Orphaned Tool-Call Output at the Assembly Layer, Not the Provider Adapter

## Context

Two provider-specific errors share the same root cause: the assistant's tool-call part is missing from the messages array sent to the LLM, while its paired tool-result part is present.

1. **Codex (OpenAI Responses)**: `No tool call found for function call output with call_id ...`
2. **DeepSeek (via LiteLLM)**: `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`

Researcher evidence established that the bug lives upstream of the provider adapters — in `MessageV2.toModelMessagesEffect` at `packages/opencode/src/session/message-v2.ts:666-956`, the central assembly function that converts `MessageV2.Assistant.parts[]` into AI SDK `ModelMessage[]`. The existing `repairOrphanedInputItems` at the OpenAI Responses adapter layer never fires because the orphan is introduced before the adapter sees the messages.

Two options were on the table: fix at the assembly layer (one change, all providers) vs. fix at the provider adapter layer (two changes, doesn't address root cause).

## Decision

Add a preserve-layer repair function inside `MessageV2.toModelMessagesEffect` that drops orphan tool-results before the array is returned to the LLM service. Add a defense-in-depth check in `LLM.validateMessages`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Fix at the opencode assembly layer | Fixes all providers with one change; addresses root cause | Touches fork code that diverges from upstream | — |
| Fix at the provider adapter layer | Closer to where error fires | Two provider-specific fixes; downstream of root cause; `repairOrphanedInputItems` already there and doesn't fire | Doesn't address root cause |
| Re-attach synthetic tool-call part | Preserves message count | Reconstructs lossy state; no precedent | Risk of confusing LLM |
| Patch upstream opencode/opencode directly | Upstream benefit | Upstream is read-only from the fork | Fork is correct place for patches |

## Consequences

- **Positive:** Codex and DeepSeek sessions stop failing with orphan errors. Any future provider that pairs tool-calls with tool-results also benefits.
- **Positive:** Single change covers both providers, keeping provider-agnostic logic out of provider-specific code.
- **Negative:** Some context is silently lost when orphaned tool-results are dropped (acceptable vs. hard session failure).
- **Neutral:** The fix should be contributed upstream as a PR to `opencode/opencode` (open decision).

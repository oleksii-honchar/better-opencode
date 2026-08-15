---
type: memory
title: "Sub-Agent Abrupt Stop — Workaround: Retry or Raise Output Token Max"
createdAt: "2026-08-15T11:15:00Z"
updatedAt: "2026-08-15T18:16:15Z"
tags: [subagent, task-tool, provider, stream, workaround, deepseek-v4-flash]
see_also:
  - "adrs/0090-retry-truncated-provider-streams.adr.md"
  - "concepts/0004-subagent-delegation.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: Sub-Agent Abrupt Stop — Workaround: Retry or Raise Output Token Max

## Fact

A sub-agent launched via the `task` tool can stop abruptly after producing a single message: the session is not persisted to disk, no error reaches the parent, and a second attempt succeeds. Root cause (upstream anomalyco/opencode#37852): the provider stream was truncated mid-generation without a finish reason; the AI SDK synthesized `finishReason: "other"`/`rawFinishReason: undefined`; the fork mapped it to `finish=unknown` and treated it as a clean completion, so `task.ts` returned an empty result. Affected model family includes `deepseek-v4-flash` (the environment model here).

## Context

The failed sub-agent session ID was never found on disk. A manual retry of the same task usually succeeds because the provider drop is transient. Before the ADR-0090 fix, this was the only practical recovery. As of fork commit `87aa1b54ae`, truncated streams are detected and retried automatically (max 2, exponential backoff).

## Impact

- **Workaround 1 (reliable):** retry the task — transient provider drop usually succeeds.
- **Workaround 2 (user-reported, mixed results):** `export OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=131072` raises output token max from 32k to 128k (deepseek-v4-flash can hit an output-length terminal state mid-reasoning). Worked for one user, not another.
- **Diagnostic signature:** empty `<task_result>`, zero-token assistant message, session missing from disk — distinguish "provider dropped stream" (transient) from "agent finished with nothing to say".

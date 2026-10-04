---
type: memory
title: "LiteLLM Streaming Spans Carry Empty usage_object (Gateway Under-Reports)"
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [litellm, telemetry, otel, gotcha]
system: shared
see_also:
  - "../concepts/0006-opencode-observability.concept.md"
  - "../adrs/0112-telemetry-visibility-startup-warn.adr.md"
  - "../runbooks/0004-token-budget-caps-and-runaway-alerting.runbook.md"
---

# Memory: LiteLLM Gateway Token Accounting Is Blind to Streaming Calls

## Fact

2,308 of 3,921 `litellm_request` spans on 2026-10-03 had empty `usage_object`
(streaming calls); gateway-visible token sums were 3.96M vs 163.7M actual. The
response model behind `openrouter/auto` is also unrecorded.

## Context

Discovered while reconciling the OpenRouter dashboard (162M) against ClickStack
during the 2026-10-03 runaway-loop investigation.

## Impact

Gateway-side alerting and provider attribution are unreliable until fixed —
acceptance criteria handed to the `puma-lan/clickstack` repo (workstream D3,
spec 0024). Until then, per-session token alerts must use opencode's own
`llm.token_count.total` spans.

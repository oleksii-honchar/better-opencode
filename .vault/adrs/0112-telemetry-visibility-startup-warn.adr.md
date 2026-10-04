---
type: decision
id: DEC-0112
title: "Telemetry Visibility: Startup Warn When OTel Endpoint Unset"
status: proposed
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [telemetry, otel, observability, incident, 2026-10-03]
system: opencode
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0006-opencode-observability.concept.md"
  - "../runbooks/0004-token-budget-caps-and-runaway-alerting.runbook.md"
  - "../memories/0027-litellm-streaming-spans-empty-usage-object.memory.md"
  - "../specifications/0024-runaway-loop-hardening.spec.md"
---

# DEC-0112: Telemetry Visibility — Startup Warn When OTel Endpoint Unset

> **Status note:** implemented on branch `261003-fix-runaway-loop-hardening` (staged,
> not yet committed/merged as of 2026-10-04). Flip to `accepted` after merge.

## Context

Telemetry is gated on `OTEL_EXPORTER_OTLP_ENDPOINT` (`observability.ts:9-10`). The
2026-10-03 runaway process had no endpoint → 0 exported spans while 163.7M tokens
burned; the incident was invisible in ClickStack (pipeline itself healthy: 140K
spans that day).

## Decision

(a) **Code:** one-time startup
`log.warn("OTel telemetry disabled: OTEL_EXPORTER_OTLP_ENDPOINT not set")` in
`packages/core/src/effect/observability.ts` (once-per-process proven by
subprocess-per-scenario tests).
(b) **Ops:** endpoint exported on macmini via `~/.zshrc` + LaunchAgent
`com.bensyne.otel-env` (done, verified live 2026-10-03).
(c) **Cross-repo requirement** (deferred to the `puma-lan/clickstack` session):
LiteLLM streaming spans must populate `usage_object` and record the upstream
response model.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| Force telemetry on with hardcoded endpoint | Breaks no-OTel environments; violates config convention |
| Accept silent mode | This is the blind spot that hid the incident |

## Consequences

- Silent telemetry blindness becomes impossible at startup; every session traceable.
- Gateway-side accounting fix tracked in memory 0027 + spec 0024 (workstream D3).

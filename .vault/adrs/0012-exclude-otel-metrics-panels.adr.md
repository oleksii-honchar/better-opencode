---
type: adr
id: ADR-0012
title: "Exclude OTEL Metrics Panels"
status: accepted
createdAt: "2026-06-14T14:00:00Z"
updatedAt: "2026-06-14T14:00:00Z"
tags: [opencode, observability, grafana, dashboard, scope]
supersedes: []
superseded_by: []
see_also: ["concepts/0006-opencode-observability.concept.md"]
---

# ADR-0012: Exclude OTEL Metrics Panels

## Context

The `otel_metrics_sum`, `otel_metrics_gauge`, and `otel_metrics_histogram` tables exist in ClickHouse but opencode does not currently emit OTEL metrics data.

## Decision

Do not include metrics panels in the initial dashboard.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Include metrics panels | Complete observability | Would show empty data, confusing users | Rejected — no metrics data |
| Add GAUGE/COUNTER to opencode | Would generate metrics data | Out of scope — would require code changes | Rejected — can be future iteration |

## Consequences

- **Positive:** Dashboard shows real data immediately (logs only)
- **Positive:** Clear scope — dashboard is log-focused, not metrics-focused
- **Negative:** Need code changes if metrics are desired later

---
type: adr
id: ADR-0011
title: "Datadog Log Explorer UX Pattern"
status: accepted
createdAt: "2026-06-14T14:00:00Z"
updatedAt: "2026-06-14T14:00:00Z"
tags: [opencode, observability, grafana, dashboard, ux]
supersedes: []
superseded_by: []
see_also: ["specifications/0003-opencode-logs-dashboard.spec.md", "concepts/0006-opencode-observability.concept.md"]
---

# ADR-0011: Datadog Log Explorer UX Pattern

## Context

The user wanted a log exploration experience similar to Datadog Log Explorer — filter presets at the top, a volume histogram, and a live-updating log table as the centerpiece. HyperDX is not the primary log browser; Grafana must serve that role.

## Decision

Design the dashboard as a Datadog-style Log Explorer with the following mapping:

| Datadog Feature | Grafana Equivalent |
|----------------|--------------------|
| Search bar | `$search` text variable → `position(Body, ...)` |
| Facet filters | `$severity`, `$session`, `$tool`, `$event_name` query variables |
| Log volume histogram | Bar-style timeseries with `toStartOfMinute` bucketing |
| Live log table | Table panel with 500 rows, 10s auto-refresh |
| Click value → add filter | Data links on log table cells that set dashboard variables |
| Click trace ID → trace view | Data link → opens Grafana Explore with trace context |

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Aggregated-only views | Simple | Unusable for actual log investigation | Rejected — defeats the purpose |
| Native Grafana Logs panel | Familiar pattern | Not supported by ClickHouse data source | Rejected |

## Consequences

- **Positive:** Familiar Datadog-style log exploration UX in Grafana
- **Positive:** All filtering and drill-down stays within a single dashboard
- **Positive:** 10s refresh keeps data current without active polling
- **Positive:** Every log value is clickable for instant re-filtering via data links

---
type: adr
id: ADR-0010
title: "Use Table Panels for Log Stream Instead of Native Logs Panel"
status: accepted
createdAt: "2026-06-14T14:00:00Z"
updatedAt: "2026-06-14T14:00:00Z"
tags: [opencode, observability, grafana, dashboard]
supersedes: []
superseded_by: []
see_also: ["specifications/0003-opencode-logs-dashboard.spec.md"]
---

# ADR-0010: Use Table Panels for Log Stream Instead of Native Logs Panel

## Context

Grafana provides a native "Logs" panel type for displaying real-time log entries with highlighting and search. The `grafana-clickhouse-datasource` plugin returns results in table format.

## Decision

Use `table` panels for log stream visualization, not the native `logs` panel type.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Native `logs` panel | Real-time log highlighting | Incompatible with ClickHouse data source output format | Rejected — cannot consume ClickHouse query results |
| Table panels | Column overrides, severity coloring, unit formatting | No line-level highlighting | ✅ Selected |

## Consequences

- **Positive:** Reliable rendering with the existing ClickHouse data source
- **Positive:** Custom column selection (timestamp, severity, body, tool_name, session_id)
- **Positive:** Supports column-level formatting (severity colors, unit display)
- **Negative:** No line-level log highlighting (acceptable — HyperDX covers raw log exploration)

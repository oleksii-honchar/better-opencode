---
type: specification
title: "OpenCode Logs Dashboard — Datadog-Style Log Explorer"
kind: feature
status: completed
createdAt: "2026-06-14T14:00:00Z"
updatedAt: "2026-06-14T14:00:00Z"
tags: [opencode, observability, grafana, dashboard, monitoring]
owner: ""
target: "2026-06-14"
see_also:
  - "adrs/0009-grafana-v2-api-format.adr.md"
  - "adrs/0010-table-panels-for-log-stream.adr.md"
  - "adrs/0011-datadog-log-explorer-ux.adr.md"
  - "adrs/0012-exclude-otel-metrics-panels.adr.md"
  - "adrs/0013-hardcode-servicename.adr.md"
  - "adrs/0014-conditional-all-macro.adr.md"
  - "adrs/0015-dashboard-tags-include-logs.adr.md"
  - "concepts/0006-opencode-observability.concept.md"
---

# Specification: OpenCode Logs Dashboard — Datadog-Style Log Explorer

## Goal

Provide a Datadog-style Log Explorer in Grafana for browsing opencode's OTEL log stream from ClickHouse — enabling filter presets, search, severity breakdown, live log table, and drill-down to traces.

## Phases

### Phase 1 — Dashboard JSON Creation

- [x] Create `opencode-logs.json` in v2 API format with 9 panels, 5 variables, 2 annotations, 5-row layout
- [x] Validate JSON structure — 132/132 validation checks pass

### Phase 2 — Deploy to puma.lan

- [x] SCP to `/home/tuiteraz/puma-lan/clickstack/config/grafana/dashboards/opencode-logs.json`
- [x] Verify provisioning — HTTP 200 via Grafana API, UID=opencode-logs, version=1, 9 panels present

### Phase 3 — Visual Verification

- [x] Chrome DevTools: all 9 panels render, filters work, data links functional
- [x] Severity colors: info=green, error=red confirmed
- [x] Search filter: typing "api_request" filters log table
- [x] Quick Filter data links: SeverityText, session_id, tool_name, event_name all functional
- [x] 10s auto-refresh: active and working
- [x] Error Events annotations: toggle ON with annotation markers

### Phase 4 — Post-Review Fixes

- [x] Severity color-text override (info=green, error=red) — fixed
- [ ] Add computed message column to Log Stream (Body shows event names, not messages) — pending

## Behaviors

- **Search:** Type in `$search` text variable → filters all panels by `Body` content using `position(Body, '$search') > 0`
- **Filter presets:** Select severity/session/tool/event_name dropdowns → all panels re-filter
- **Click to filter:** Click SeverityText/session_id/tool_name/event_name in log table → sets dashboard variable
- **Click TraceId:** Opens Grafana Explore with trace context
- **Auto-refresh:** Dashboard refreshes every 10 seconds
- **Error Events annotations:** Red markers on histogram for ERROR severity logs

## Risks

- **10s auto-refresh overload:** Mitigated by efficient aggregations using bucket functions and `ORDER BY Timestamp DESC LIMIT 500` (indexed query)
- **position(Body, $search) slow:** Mitigated by default `now-30m` time range (small row count)
- **No metrics panels:** Explicit scoping per ADR-0012; can be added later

## Links

- ADR-0009: Use Grafana v2 API Format
- ADR-0010: Use Table Panels for Log Stream
- ADR-0011: Datadog Log Explorer UX Pattern
- ADR-0012: Exclude OTEL Metrics Panels
- ADR-0013: Hardcode ServiceName
- ADR-0014: Use $__conditionalAll Macro
- ADR-0015: Dashboard Tags Include `logs`
- Concept: OpenCode Observability

---
type: concept
title: "OpenCode Observability (OTEL)"
createdAt: "2026-06-14T14:00:00Z"
updatedAt: "2026-06-14T14:00:00Z"
tags: [opencode, observability, otel, telemetry, monitoring]
see_also:
  - "specifications/0003-opencode-logs-dashboard.spec.md"
  - "adrs/0009-grafana-v2-api-format.adr.md"
  - "adrs/0011-datadog-log-explorer-ux.adr.md"
---

# Concept: OpenCode Observability (OTEL)

## What

OpenCode uses the [Effect](https://effect.website) ecosystem with `@effect/opentelemetry` and `@opentelemetry/exporter-trace-otlp-http` to emit **traces** and **logs** via OpenTelemetry (OTEL). The telemetry pipeline is:

```
opencode → OTLP HTTP Exporter → clickstack-otel-collector → ClickHouse (otel_logs, otel_traces)
                                                               ↓
                                              Grafana dashboards (opencode-sessions, opencode-logs, llm-monitoring)
```

Telemetry is **conditional** — enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable is set. Implementation lives in `packages/core/src/effect/observability.ts`.

## Why

Observability is essential for understanding opencode's runtime behavior — agent sessions, tool execution, LLM calls, and errors. The OTEL pipeline powers three Grafana dashboards on the puma-lan homelab stack (ClickStack).

## Key Details

### Data Sources

- **`otel_logs`** — 143K records (all services), with `Body`, `SeverityText`, `LogAttributes` (Map<String,String>), `TraceId`/`SpanId`
- **`otel_traces`** — 130K traces, spans with `SpanName`, `SpanAttributes`, `Duration` (nanoseconds), `StatusCode`
- **Data source UID:** `eflo7s1l49ypsf` (grafana-clickhouse-datasource)

### Log Record Attributes

`duration_ms`, `event.name`, `project.id`, `session.id`, `success`, `tool_name`, `tool_result_size_bytes`

### Distinct Trace Span Types

- `opencode.llm` (Client) — LLM inference calls
- `opencode.session` (Internal) — Session lifecycle
- `opencode.tool.<name>` (Internal) — Tool execution (80+ tools)
- `opencode.tool.invalid` (Internal) — Failed/invalid tool call

### Resource Attributes

`deployment.environment.name`, `opencode.client`, `opencode.process_role`, `opencode.run_id`, `service.instance.id`

### Common Query Patterns (ClickHouse)

```sql
WHERE ServiceName = 'opencode'
AND $__timeFilter(Timestamp)
AND $__conditionalAll(SeverityText IN ($severity), $severity)
-- Map access: toString(LogAttributes['key'])
-- Guard: has(LogAttributes, 'key')
-- Duration: Duration / 1e6  (ns → ms)
```

### Grafana Dashboards

| Dashboard | Data Source | Panels | Purpose |
|-----------|-------------|--------|---------|
| **opencode-logs** (v2 API) | `otel_logs` | 9 panels (histogram, stats, log table, drill-down) | Datadog-style log explorer |
| **opencode-sessions** (classic) | `otel_traces` | 5 panels (timeline, token breakdown, tool calls, LLM calls, error rate) | Session-level trace visualization |
| **llm-monitoring** (v2 API) | `otel_traces` | Multiple panels (calls, latency, tokens, caching) | LLM-specific telemetry |

### Infrastructure (puma-lan ClickStack)

| Container | Image |
|-----------|-------|
| `clickstack-ch-server` | clickhouse/clickhouse-server:26.1-alpine |
| `clickstack-otel-collector` | clickhouse/clickstack-otel-collector:2.20.0 |
| `clickstack-grafana` | grafana/grafana:13.0.1 |
| `clickstack-app` (HyperDX) | hyperdx/hyperdx:2.20.0 |

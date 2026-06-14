---
type: adr
id: ADR-0013
title: "Hardcode ServiceName Instead of Using a Dashboard Variable"
status: accepted
createdAt: "2026-06-14T14:00:00Z"
updatedAt: "2026-06-14T14:00:00Z"
tags: [opencode, observability, grafana, dashboard, sql]
supersedes: []
superseded_by: []
see_also: ["specifications/0003-opencode-logs-dashboard.spec.md"]
---

# ADR-0013: Hardcode ServiceName Instead of Using a Dashboard Variable

## Context

The initial design proposed a `$service` variable for filtering logs by service. All opencode logs share `ServiceName = 'opencode'`.

## Decision

Remove the `$service` variable entirely and hardcode `ServiceName = 'opencode'` in every SQL query. This matches the existing pattern in `opencode-sessions.json` and `llm-monitoring.json`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Query variable | Clean variable pattern | Returns one value — misleading UI | Rejected — single-value multi-select is confusing |
| Custom text variable | User-defined | Fragile quoting requirements for ClickHouse | Rejected — easy to get wrong |

## Consequences

- **Positive:** Matches existing dashboard pattern exactly
- **Positive:** Cleaner UI (4 dropdowns instead of 5)
- **Positive:** Eliminates SQL quoting edge case
- **Negative:** Dashboard is opencode-specific (cannot be trivially reused for other services)

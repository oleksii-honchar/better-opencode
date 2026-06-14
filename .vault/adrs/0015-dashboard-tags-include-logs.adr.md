---
type: adr
id: ADR-0015
title: "Dashboard Tags Include `logs` for Discovery"
status: accepted
createdAt: "2026-06-14T14:00:00Z"
updatedAt: "2026-06-14T14:00:00Z"
tags: [opencode, observability, grafana, dashboard, naming]
supersedes: []
superseded_by: []
see_also: ["specifications/0003-opencode-logs-dashboard.spec.md"]
---

# ADR-0015: Dashboard Tags Include `logs` for Discovery

## Context

Existing dashboards use tags `opencode` and `clickstack`. The new log-focused dashboard needs discoverability as a log browser.

## Decision

Tags: `["opencode", "logs", "clickstack"]`

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| `["opencode", "clickstack"]` | Matches existing pattern | No way to filter log dashboards | Rejected — need log discovery |
| `["opencode", "logs", "telemetry"]` | Descriptive | `telemetry` too broad | Rejected — `clickstack` identifies the stack |

## Consequences

- **Positive:** Easy to find all log dashboards with tag filter `logs`
- **Positive:** Future log dashboards for other services can share the `logs` tag

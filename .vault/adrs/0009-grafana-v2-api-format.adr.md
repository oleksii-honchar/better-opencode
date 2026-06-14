---
type: adr
id: ADR-0009
title: "Use Grafana v2 API Format"
status: accepted
createdAt: "2026-06-14T14:00:00Z"
updatedAt: "2026-06-14T14:00:00Z"
tags: [opencode, observability, grafana, dashboard]
supersedes: []
superseded_by: []
see_also: ["specifications/0003-opencode-logs-dashboard.spec.md"]
---

# ADR-0009: Use Grafana v2 API Format

## Context

The existing dashboards on puma-lan use two formats: `opencode-sessions.json` (classic panels array + templating) and `llm-monitoring.json` (newer v2 API format `dashboard.grafana.app/v2`). The new opencode-logs dashboard needed to choose a format.

## Decision

Use the v2 API format (`apiVersion: dashboard.grafana.app/v2`, `kind: Dashboard`) for the new dashboard.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Classic format (`opencode-sessions.json` style) | Simpler structure, proven in production | Older pattern, less metadata support | Rejected — v2 format is forward-looking |
| v2 API format | Stronger metadata (resourceVersion, generation, labels), forward-compatible | Slightly more verbose JSON | ✅ Selected |

## Consequences

- **Positive:** Consistent with the most recent dashboard on the stack
- **Positive:** Better metadata tracking for file-based provisioning
- **Neutral:** Slightly more verbose JSON structure

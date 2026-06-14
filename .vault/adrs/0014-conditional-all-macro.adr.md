---
type: adr
id: ADR-0014
title: "Use $__conditionalAll Macro for Multi-Select Variable Safety"
status: accepted
createdAt: "2026-06-14T14:00:00Z"
updatedAt: "2026-06-14T14:00:00Z"
tags: [opencode, observability, grafana, dashboard, sql, safety]
supersedes: []
superseded_by: []
see_also: ["specifications/0003-opencode-logs-dashboard.spec.md"]
---

# ADR-0014: Use $__conditionalAll Macro for Multi-Select Variable Safety

## Context

Grafana multi-select variables with "All" option produce `$__all` when all values are selected. Raw `IN ($var)` in SQL fails with `$__all`.

## Decision

Use `$__conditionalAll(column IN ($var), $var)` pattern for all query-based variables in WHERE clauses.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| `IN ($var)` without macro | Simpler SQL | Breaks on "All" selection | Rejected — fails at runtime |
| Custom conditional logic | Explicit | Harder to read, error-prone | Rejected — standard macro exists |

## Consequences

- **Positive:** Consistent with existing dashboard patterns on puma-lan
- **Positive:** Safe for multi-select variables with "All" option
- **Positive:** Prevents silent data loss when switching to "All"

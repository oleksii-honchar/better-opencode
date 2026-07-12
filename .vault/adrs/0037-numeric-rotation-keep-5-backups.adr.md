---
type: adr
id: ADR-0037
title: "Numeric Rotation — Keep 5 Backups"
status: accepted
createdAt: "2026-07-12T19:47:00Z"
updatedAt: "2026-07-12T19:47:00Z"
tags: [logging, infrastructure]
supersedes: []
superseded_by: []
see_also: ["adrs/0035-json-lines-format-for-tools-log.adr.md"]
---

# ADR-0037: Numeric Rotation — Keep 5 Backups

## Context

`tools.log` can grow quickly when enabled. We need a simple rotation strategy.

## Decision

On `Log.init()`, if `tools.log` exists and `shouldTruncate` is true, shift backups (`tools.log` → `tools-1.log` → ... → `tools-5.log`), dropping the oldest.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Daily timestamped files | Correlates with calendar days | Adds parsing/complexity; correlation with calendar less important for debugging | Rejected — over-engineered for debugging use case |
| No rotation | Simplest | Unbounded disk usage | Rejected — disk usage unbounded |

## Consequences

- **Positive:** Simple to implement with `fs.rename`; predictable file names.
- **Positive:** At most 6 files (`tools.log` + 5 backups) in the log directory.
- **Neutral:** Reuses existing "truncate on new run" semantics from the general log.
- **Negative:** Rotation only happens on process start, not on size threshold.

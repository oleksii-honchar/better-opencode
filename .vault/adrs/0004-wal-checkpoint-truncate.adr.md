---
type: adr
id: ADR-0004
title: "Background WAL Checkpoint — TRUNCATE Mode"
status: accepted
createdAt: "2026-06-10T14:30:00Z"
updatedAt: "2026-06-10T14:30:00Z"
tags: [database, wal, performance, maintenance]
see_also:
  - "adrs/0002-hybrid-cli-background.adr.md"
  - "adrs/0005-journal-size-limit.adr.md"
  - "runbooks/0001-opencode-db-maintenance.runbook.md"
  - "specifications/0001-opencode-db-cleanup.spec.md"
---

# ADR-0004: Background WAL Checkpoint — TRUNCATE Mode

## Context

The WAL journal can grow between PRAGMA checkpoints. The startup-only `PASSIVE` checkpoint may not reclaim space under write load.

## Decision

Use `PRAGMA wal_checkpoint(TRUNCATE)` for the background loop, not `PASSIVE`.

## Rationale

- `TRUNCATE` truncates the WAL file to zero (reclaims disk space)
- `PASSIVE` only checkpoints without truncation — the WAL file stays at its current size
- `TRUNCATE` is safe: if there are active readers, it falls back to PASSIVE automatically
- Startup checkpoint stays as `PASSIVE` (fast, non-blocking init)

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| PASSIVE only | Fast, non-blocking | WAL not truncated — file stays at peak size | Doesn't bound disk usage |
| RESTART | Truncates WAL | Requires no active readers — may fail during active sessions | TRUNCATE is safer (auto-fallback) |
| FULL | Full checkpoint | Same as TRUNCATE but can block writers | TRUNCATE is fine for this use case |

## Consequences

- **Positive:** WAL file stays small (target <16MB) even during long sessions
- **Positive:** No risk of WAL consuming disproportionate disk
- **Negative:** Slightly more I/O at checkpoint time than PASSIVE

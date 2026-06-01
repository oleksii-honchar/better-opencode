---
type: adr
id: ADR-0002
title: "Hybrid Approach for DB Maintenance (CLI + Background)"
status: accepted
createdAt: "2026-06-10T14:30:00Z"
updatedAt: "2026-06-10T14:30:00Z"
tags: [database, maintenance, cli, background-jobs]
see_also:
  - "adrs/0003-existing-time-archived-cascade.adr.md"
  - "adrs/0004-wal-checkpoint-truncate.adr.md"
  - "adrs/0005-journal-size-limit.adr.md"
  - "adrs/0006-tool-output-age-deletion.adr.md"
  - "specifications/0001-opencode-db-cleanup.spec.md"
---

# ADR-0002: Hybrid Approach for DB Maintenance (CLI + Background)

## Context

The ~1GB opencode SQLite database needs ongoing maintenance. The design could be purely manual (CLI commands only), fully automated (background daemon), or a hybrid.

## Decision

Hybrid. CLI commands for explicit user-triggered cleanup. Background job for WAL checkpoint only.

## Rationale

- CLI for destructive operations (session deletion, VACUUM) puts the user in control
- Background for WAL checkpointing is low-risk and prevents unbounded WAL growth between startup checkpoints
- Existing `BackgroundJob` infrastructure makes the background part trivial to add
- VACUUM is expensive (rewrites entire DB) — should never run without user awareness

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| CLI-only | Simple, predictable | DB will grow back, WAL unbounded — user must remember to run commands | WAL can grow unbounded between sessions |
| Fully automated | Set-and-forget | Background VACUUM could cause I/O spikes; automated session deletion risks accidental data loss | Destructive ops need user consent |

## Consequences

- **Positive:** User has explicit control over destructive operations
- **Positive:** WAL stays bounded without user intervention
- **Negative:** Two-paradigm system slightly increases code surface

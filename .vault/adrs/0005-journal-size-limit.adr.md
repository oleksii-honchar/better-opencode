---
type: adr
id: ADR-0005
title: "PRAGMA journal_size_limit Instead of auto_vacuum"
status: accepted
createdAt: "2026-06-10T14:30:00Z"
updatedAt: "2026-06-10T14:30:00Z"
tags: [database, sqlite, pragma, maintenance]
see_also:
  - "adrs/0002-hybrid-cli-background.adr.md"
  - "adrs/0004-wal-checkpoint-truncate.adr.md"
  - "memories/0002-no-automated-db-maintenance.memory.md"
  - "runbooks/0001-opencode-db-maintenance.runbook.md"
---

# ADR-0005: PRAGMA journal_size_limit Instead of auto_vacuum

## Context

Two SQLite PRAGMAs can improve database maintenance: `journal_size_limit` (caps WAL) and `auto_vacuum` (auto-reclaims free pages).

## Decision

Add `journal_size_limit = 16777216` (16MB). Do NOT enable `auto_vacuum`.

## Rationale

- `journal_size_limit` bounds WAL growth with zero cost — pure win
- `auto_vacuum` fragments the database file (pages are moved but space is not returned to OS) and has runtime overhead on every delete
- `VACUUM` (full rebuild) is better for space reclamation — run it explicitly via CLI

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| auto_vacuum = INCREMENTAL | Auto space reclamation | DB fragmentation, runtime overhead on deletes, don't return space to OS | VACUUM is cleaner for infrequent use |
| auto_vacuum = FULL | Full auto reclamation | Even more overhead, rewrites pages on every delete | Way too expensive for write-heavy session DB |
| Both | Maximum coverage | Complexity + fragmentation + overhead | Over-engineered |

## Consequences

- **Positive:** WAL stays bounded with zero runtime overhead
- **Positive:** No fragmentation from auto_vacuum
- **Negative:** User must remember to run `opencode db vacuum` periodically for maximum space recovery

---
type: specification
title: "OpenCode SQLite Database Cleanup"
kind: feature
status: completed
createdAt: "2026-06-10T14:30:00Z"
updatedAt: "2026-06-10T18:55:00Z"
tags: [database, maintenance, sqlite, performance]
owner: "oleksii.honchar"
target: 2026-06-10
see_also:
  - "adrs/0002-hybrid-cli-background.adr.md"
  - "adrs/0003-existing-time-archived-cascade.adr.md"
  - "adrs/0004-wal-checkpoint-truncate.adr.md"
  - "adrs/0005-journal-size-limit.adr.md"
  - "adrs/0006-tool-output-age-deletion.adr.md"
  - "runbooks/0001-opencode-db-maintenance.runbook.md"
  - "memories/0001-part-table-dominance.memory.md"
  - "memories/0002-no-automated-db-maintenance.memory.md"
  - "concepts/0001-session-model.concept.md"
  - "concepts/0003-llm-turn-management.concept.md"
---

# Specification: OpenCode SQLite Database Cleanup

## Goal

Clean up and maintain the opencode SQLite database (`opencode-local.db`, 849MB) to reduce storage consumption, bound write amplification (20-30 MB/s sustained), and provide user-invokable maintenance tooling. The approach is **hybrid**: CLI commands for explicit cleanup + minimal background maintenance (WAL checkpoint) + PRAGMA tunings.

## Components

### 1. DB Layer PRAGMA Changes (`storage/db.ts`)
- Add `PRAGMA journal_size_limit = 16777216` (16MB WAL cap)
- Startup WAL checkpoint already existed as `PASSIVE`

### 2. DB CLI Commands (`cli/cmd/db.ts`)
- **`opencode db vacuum`** — Runs `VACUUM` + `PRAGMA wal_checkpoint(TRUNCATE)`, prints freed space
- **`opencode db checkpoint`** — Runs `PRAGMA wal_checkpoint(TRUNCATE)` for manual WAL trimming
- **`opencode db compact [--older-than 90d] [--dry-run]`** — Deletes compacted parts (any age) + old tool parts (>90d), runs VACUUM + TRUNCATE afterward
- **`opencode db stats`** — Shows DB/WAL size, free pages, row counts, oldest session, VACUUM recommendation

### 3. Session Cleanup CLI (`cli/cmd/session.ts`)
- **`opencode session cleanup [--older-than 90d] [--dry-run]`** — Lists old sessions, archives then deletes via Drizzle cascade

### 4. Background WAL Maintenance (`storage/db.ts`)
- `startWalCheckpointLoop()` spawned at startup
- Runs every 10 minutes, checks WAL file size via `fs.statSync`
- If WAL > 16MB or last checkpoint > 30 min ago: `PRAGMA wal_checkpoint(TRUNCATE)`
- Disabled via `OPENCODE_DB_NO_AUTO_CHECKPOINT=1`

### 5. Session Service Enhancement (`session/session.ts`)
- `listGlobal` enhanced with `olderThan` (number) and `archived` (boolean) filters

## Phases

### Phase 0 — Quick Wins (5 min)
- [x] `PRAGMA journal_size_limit = 16777216` added to `storage/db.ts`
- [x] Stale DB files can be manually deleted

### Phase 1 — CLI Infrastructure
- [x] `opencode db vacuum`
- [x] `opencode db checkpoint`
- [x] `opencode db stats`
- [x] `opencode db compact` (with `--dry-run`, `--older-than`)

### Phase 2 — Session Cleanup
- [x] `opencode session cleanup` (with `--dry-run`, `--older-than`)
- [x] `listGlobal` enhanced with age/archived filters

### Phase 3 — Background WAL Maintenance
- [x] `startWalCheckpointLoop()` function
- [x] Wired into runtime startup in `storage/db.ts`
- [x] Tests verify loop runs without error

## Behaviors

- `opencode db compact` uses raw SQL `json_extract()` for detecting compacted parts — not Drizzle ORM
- `opencode session cleanup` uses two-phase: archive first, then cascade delete via Drizzle FK
- Background WAL uses `PRAGMA wal_checkpoint(TRUNCATE)` — safe fallback to PASSIVE if busy
- All destructive commands support `--dry-run` for preview
- Background loop can be disabled via `OPENCODE_DB_NO_AUTO_CHECKPOINT` env var

## Success Criteria

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| DB file size | 849 MB | <400 MB | CLI tools in place |
| WAL file size | unbounded | <16 MB at all times | ✅ Achieved via journal_size_limit + periodic TRUNCATE |
| Stale DB files | 2 files, ~20 MB | 0 | Detected, manual cleanup available |
| Daily write volume | ~20 MB/day | ~10-15 MB/day (WAL capped) | Background loop mitigates |
| Active session deletion | Manual only | Bulk via `opencode session cleanup` | ✅ Implemented |
| DB maintenance commands | None | vacuum, checkpoint, compact, stats | ✅ All implemented |

## Risks

- **Accidental deletion:** Mitigated by `--dry-run` + confirmation + archive-then-delete pattern
- **VACUUM I/O:** CLI-only (user-initiated), never runs in background
- **WAL checkpoint conflicts:** `TRUNCATE` falls back to `PASSIVE` if busy
- **`json_extract` performance:** Only runs during `opencode db compact` (one-shot CLI)

---
type: memory
title: "OpenCode Database Had No Automated Maintenance Before DB Cleanup Feature"
createdAt: "2026-06-10T14:26:00Z"
updatedAt: "2026-06-10T14:26:00Z"
tags: [database, maintenance, sqlite, discovery]
see_also:
  - "adrs/0005-journal-size-limit.adr.md"
  - "specifications/0001-opencode-db-cleanup.spec.md"
  - "memories/0001-part-table-dominance.memory.md"
---

# Memory: OpenCode Database Had No Automated Maintenance Before DB Cleanup Feature

## Fact

Before the June 2026 DB cleanup feature, opencode's SQLite database had **no automated maintenance**: no `VACUUM` ever called, no `PRAGMA journal_size_limit` set, no periodic WAL checkpointing, no session archival/cleanup, and no auto_vacuum configured. WAL checkpoint was only performed at startup via `PRAGMA wal_checkpoint(PASSIVE)`, which does not truncate the WAL file.

## Context

Discovered during investigation of a ~1GB database. Analysis of `storage/db.ts` initialization code and database maintenance patterns revealed that all maintenance was purely reactive — compaction only triggered on context overflow (when LLM token limit was exceeded), and sessions persisted forever unless manually deleted.

## Impact

- Free pages from deleted data were never reclaimed — the DB file only grows, never shrinks
- WAL file could grow unboundedly between startup sessions
- Session count reached 1,615 (all 3+ months old, none ever cleaned up)
- The "Background WAL Checkpoint" feature (June 2026) and `journal_size_limit` PRAGMA were the first automated maintenance mechanisms added to the codebase

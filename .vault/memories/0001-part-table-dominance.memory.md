---
type: memory
title: "Part Table Is 91% of OpenCode SQLite Database"
createdAt: "2026-06-10T14:26:00Z"
updatedAt: "2026-06-10T14:26:00Z"
tags: [database, sqlite, performance, discovery]
see_also:
  - "specifications/0001-opencode-db-cleanup.spec.md"
  - "adrs/0006-tool-output-age-deletion.adr.md"
  - "memories/0002-no-automated-db-maintenance.memory.md"
---

# Memory: Part Table Is 91% of OpenCode SQLite Database

## Fact

The `part` table in opencode's SQLite database (`opencode-local.db`) contains 333,365 rows consuming ~774 MB — **91% of the total 849MB database**. Of that, tool call result parts (90,440 rows) take 517.5 MB (67%). The top contributors are `read` (199 MB), `edit` (105 MB), `bash` (92 MB), `write` (34 MB), and screenshots (24 MB).

## Context

Discovered during investigation of a ~1GB opencode database on June 10, 2026. The user reported VS Code sluggishness and high SSD I/O (20-30 MB/s sustained writes). Schema profiling revealed the disproportionate size of the `part` table.

## Impact

- Any optimization targeting database size must focus on the `part` table
- The compaction system only marks parts as compacted but does NOT delete them — 7,988 parts (2.4%) are marked compacted, yet all 333K rows remain
- Each active day adds ~20 MB of new data to the DB
- Session archival alone (deleting old sessions) cascades to delete their parts — the most effective space recovery strategy is combining session cleanup + part compaction

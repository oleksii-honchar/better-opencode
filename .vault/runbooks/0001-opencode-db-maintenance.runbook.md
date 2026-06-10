---
type: runbook
title: "OpenCode Database Maintenance"
createdAt: "2026-06-10T18:55:00Z"
updatedAt: "2026-06-10T18:55:00Z"
tags: [database, maintenance, operations, sqlite]
see_also:
  - "specifications/0001-opencode-db-cleanup.spec.md"
  - "adrs/0002-hybrid-cli-background.adr.md"
  - "adrs/0004-wal-checkpoint-truncate.adr.md"
  - "adrs/0005-journal-size-limit.adr.md"
  - "adrs/0006-tool-output-age-deletion.adr.md"
  - "concepts/0001-session-model.concept.md"
---

# Runbook: OpenCode Database Maintenance

## Prerequisites

- OpenCode running from the better-opencode fork
- Database at `~/.local/share/opencode/opencode-local.db`
- CLI commands available via `opencode db` and `opencode session`

## Steps

### Check Database Health

```bash
opencode db stats
```

Shows: DB file size, WAL size, free page count, row counts per table, oldest session date, VACUUM recommendation.

### Compact Old Tool Outputs (Space Reclamation)

```bash
# Preview what would be deleted (safe, no changes)
opencode db compact --dry-run

# Actually delete compacted parts + tool outputs older than 90 days
opencode db compact

# Custom threshold
opencode db compact --older-than 30d
```

This deletes:
1. Parts already marked as compacted (any age) — tool outputs already summarized by the compaction system
2. Tool call parts from sessions older than the threshold — unlikely to be reviewed

### Clean Up Old Sessions

```bash
# Preview what would be archived and deleted
opencode session cleanup --dry-run

# Archive and delete sessions older than 90 days
opencode session cleanup
```

Uses two-phase pattern: archives first (sets `time_archived`), then deletes with Drizzle FK cascade (session → message → part).

### Vacuum Database (Full Rebuild)

```bash
opencode db vacuum
```

Rewrites the entire database file, reclaiming all free pages. Best run after `opencode db compact` and `opencode session cleanup`. May take several seconds on large databases.

### Manual WAL Checkpoint

```bash
opencode db checkpoint
```

Truncates the WAL journal immediately. Useful if you notice the WAL file has grown large and you don't want to wait for the background loop (every 10 min).

### Disable Background WAL Checkpoint

```bash
export OPENCODE_DB_NO_AUTO_CHECKPOINT=1
opencode
```

## Verification

- Run `opencode db stats` before and after any maintenance to verify space was reclaimed
- After VACUUM, the `free_pages` count should be near zero
- After checkpoint, the WAL file should shrink to near-zero
- Recent sessions should still appear in `opencode session list`

## Rollback

- **Session cleanup is destructive:** Archived sessions are soft-deleted via `time_archived` first, but `session.remove()` is permanent. No automated rollback. Recommend `--dry-run` before execution.
- **Compact is destructive:** Deleted parts are gone. No rollback. Future sessions will accumulate new parts.
- **VACUUM is irreversible:** Rewrites the DB. No rollback. Run only after confirming compact/cleanup results.
- **Background checkpoint is safe:** Can be disabled at any time via env var. No rollback needed.

## See Also

- The background WAL checkpoint loop runs automatically at startup (10-min interval, checkpoints if WAL > 16MB)
- `PRAGMA journal_size_limit = 16777216` is set automatically on startup — WAL file is capped at 16MB

#!/bin/bash
# opencode-db-cleanup.sh — Database maintenance for OpenCode SQLite databases
#
# Safely cleans up old sessions, compacted tool outputs, stale DB files,
# runs VACUUM, and checkpoints WAL — with dry-run preview.
#
# Usage:
#   ./scripts/opencode-db-cleanup.sh                           # interactive (prompts before each step)
#   ./scripts/opencode-db-cleanup.sh --dry-run                  # preview what would be done
#   ./scripts/opencode-db-cleanup.sh --force                    # skip all prompts, run everything
#   ./scripts/opencode-db-cleanup.sh --db opencode-local.db     # target a specific DB
#
# Individual steps (combine as needed):
#   --vacuum         # VACUUM + reindex (reclaims free pages)
#   --checkpoint     # WAL checkpoint (truncates WAL file)
#   --compact        # delete compacted + old tool outputs
#	--clean-sessions # delete sessions older than N days (default: 30)
#	--clean-stale    # delete stale DB files
#	--all            # run all steps (default if no --step flags given)
#	--older-than 30  # session age threshold in days
#
# Requirements: sqlite3, opencode CLI, jq
#
# Examples:
#   ./scripts/opencode-db-cleanup.sh --dry-run
#   ./scripts/opencode-db-cleanup.sh --compact --vacuum --checkpoint
#   ./scripts/opencode-db-cleanup.sh --clean-sessions --older-than 60 --force

set -euo pipefail

# ── paths ────────────────────────────────────────────────────────────
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=false
FORCE=false
DO_ALL=false
DO_VACUUM=false
DO_CHECKPOINT=false
DO_COMPACT=false
DO_CLEAN_SESSIONS=false
DO_CLEAN_STALE=false
DB_NAME=""
OLDER_THAN_DAYS=30
SUMMARY_LINES=()

# ── helpers ──────────────────────────────────────────────────────────
hr()    { printf '%*s\n' "${1:-60}" '' | tr ' ' '─'; }
green() { echo -e "\033[32m$*\033[0m"; }
red()   { echo -e "\033[31m$*\033[0m"; }
bold()  { echo -e "\033[1m$*\033[0m"; }
dim()   { echo -e "\033[2m$*\033[0m"; }

to_human() {
  if command -v numfmt &>/dev/null; then numfmt --to=iec "$1"
  elif command -v perl &>/dev/null; then
    perl -e 'my $b=shift; my @u=("B","KB","MB","GB"); my $i=0; while($b>1024 && $i<3){$b/=1024;$i++} printf("%.1f %s\n",$b,$u[$i])' "$1"
  else echo "${1}B"
  fi
}

log() {
  local prefix="[DRY-RUN]"
  $DRY_RUN || prefix=""
  echo "$prefix $*"
}

run() {
  if $DRY_RUN; then
    dim "    would run: $*"
    return 0
  fi
  if ! $FORCE; then
    bold "Run: $*"
    read -r -p "  Continue? [Y/n] " REPLY
    if [[ "$REPLY" =~ ^[Nn] ]]; then
      echo "  ✗ Skipped"
      return 0
    fi
  fi
  "$@"
}

confirm_step() {
  local label="$1"
  if $FORCE; then return 0; fi
  if $DRY_RUN; then return 0; fi  # dry-run shows everything anyway
  bold ""
  bold "── Step: $label ──"
  read -r -p "Proceed with this step? [Y/n/q] " REPLY
  case "$REPLY" in
    [Qq]) echo "Quitting."; exit 0 ;;
    [Nn]) echo "  ✗ Skipped"; return 1 ;;
    *) return 0 ;;
  esac
}

# ── argument parsing ─────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)     DRY_RUN=true ;;
    --force|-f)    FORCE=true ;;
    --vacuum)      DO_VACUUM=true ;;
    --checkpoint)  DO_CHECKPOINT=true ;;
    --compact)     DO_COMPACT=true ;;
    --clean-sessions) DO_CLEAN_SESSIONS=true ;;
    --clean-stale) DO_CLEAN_STALE=true ;;
    --all)         DO_ALL=true ;;
    --db)          DB_NAME="$2"; shift ;;
    --older-than)  OLDER_THAN_DAYS="$2"; shift ;;
    --help|-h)
      sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# //; s/^#$//'
      exit 0 ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--dry-run] [--force] [--all|--step1 --step2 ...] [--db name] [--older-than N]"
      exit 1 ;;
  esac
  shift
done

# Default: run all steps if none specified
if ! $DO_VACUUM && ! $DO_CHECKPOINT && ! $DO_COMPACT && ! $DO_CLEAN_SESSIONS && ! $DO_CLEAN_STALE; then
  DO_ALL=true
fi

if $DO_ALL; then
  DO_VACUUM=true
  DO_CHECKPOINT=true
  DO_COMPACT=true
  DO_CLEAN_SESSIONS=true
  DO_CLEAN_STALE=true
fi

# ── prerequisites ─────────────────────────────────────────────────────
if ! command -v sqlite3 &>/dev/null; then
  echo "Error: sqlite3 not found. Install it: brew install sqlite3"
  exit 1
fi
if ! command -v opencode &>/dev/null; then
  echo "Warning: opencode CLI not on PATH — session listing/deletion unavailable"
fi

echo ""
bold "OpenCode DB Cleanup"
$DRY_RUN && red "  DRY RUN MODE — nothing will be modified"
$FORCE   && red "  FORCE MODE — all steps will run without confirmation"
echo ""

# ── DB detection ──────────────────────────────────────────────────────
if [[ -n "$DB_NAME" ]]; then
  TARGET_DB="$DATA_DIR/$DB_NAME"
  if [[ ! -f "$TARGET_DB" ]]; then
    echo "Error: Database not found: $TARGET_DB"
    exit 1
  fi
  TARGET_DBS=("$TARGET_DB")
else
  TARGET_DBS=()
  while IFS= read -r -d '' f; do
    case "$(basename "$f")" in
      *.db-wal|*.db-shm) continue ;;
      opencode-260430-*|opencode-patched-dev*) continue ;; # stale — handled separately
      opencode*.db) TARGET_DBS+=("$f") ;;
    esac
  done < <(find "$DATA_DIR" -maxdepth 1 -name 'opencode*.db' -print0 2>/dev/null)

  if [[ ${#TARGET_DBS[@]} -eq 0 ]]; then
    echo "No opencode databases found in $DATA_DIR"
    exit 1
  fi
fi

# ── helpers for DB operations ─────────────────────────────────────────
db_sql() {
  local db="$1"; shift
  sqlite3 "$db" "$@"
}

db_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
}

db_was_modified_recently() {
  local db="$1" cutoff=$(( $(date +%s) - 300 ))  # 5 min
  local mtime
  mtime=$(stat -f%m "$db" 2>/dev/null || stat -c%Y "$db" 2>/dev/null || echo 0)
  [[ "$mtime" -ge "$cutoff" ]]
}

ensure_safe_to_modify() {
  local db="$1"
  if db_was_modified_recently "$db"; then
    bold "⚠  $db was modified less than 5 minutes ago."
    bold "   OpenCode may be using it. Close opencode first, or skip this DB."
    if $FORCE; then
      echo "   (force mode — proceeding anyway)"
      return 0
    fi
    read -r -p "  Continue anyway? [y/N] " REPLY
    [[ "$REPLY" =~ ^[Yy] ]] || return 1
  fi
  return 0
}

# ══════════════════════════════════════════════════════════════════════
#  STEP 1: VACUUM + REINDEX
# ══════════════════════════════════════════════════════════════════════
if $DO_VACUUM; then
  echo ""
  hr
  bold "Step 1: VACUUM & REINDEX"
  echo "  Reclaims free pages and defragments the database."
  echo ""

  for DB in "${TARGET_DBS[@]}"; do
    NAME=$(basename "$DB")
    BEFORE=$(db_size "$DB")
    FREE=$(db_sql "$DB" "PRAGMA freelist_count;" 2>/dev/null || echo 0)

    if [[ "$FREE" -eq 0 ]]; then
      echo "  $NAME: no free pages — VACUUM not needed"
      continue
    fi

    log "VACUUM $NAME (free pages: $FREE)"
    confirm_step "VACUUM $NAME" || continue
    run sqlite3 "$DB" "VACUUM;"
    run sqlite3 "$DB" "REINDEX;"
    if ! $DRY_RUN; then
      AFTER=$(db_size "$DB")
      SAVED=$(( BEFORE - AFTER ))
      green "  ✓ VACUUM $NAME: $(to_human $SAVED) reclaimed, $(to_human $AFTER) remaining"
      SUMMARY_LINES+=("VACUUM $NAME: freed $(to_human $SAVED)")
    fi
  done
fi

# ══════════════════════════════════════════════════════════════════════
#  STEP 2: WAL CHECKPOINT & journal_size_limit
# ══════════════════════════════════════════════════════════════════════
if $DO_CHECKPOINT; then
  echo ""
  hr
  bold "Step 2: WAL Checkpoint & journal_size_limit"
  echo "  Caps WAL journal growth and truncates the WAL file."
  echo ""

  for DB in "${TARGET_DBS[@]}"; do
    NAME=$(basename "$DB")
    WAL="${DB}-wal"
    WAL_BEFORE=0
    [[ -f "$WAL" ]] && WAL_BEFORE=$(db_size "$WAL")

    log "Set journal_size_limit=16MB + checkpoint $NAME"
    confirm_step "Checkpoint $NAME" || continue

    # Set journal_size_limit (persists in DB)
    run sqlite3 "$DB" "PRAGMA journal_size_limit = 16777216;"
    # Force checkpoint with truncation
    run sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);"

    if ! $DRY_RUN; then
      WAL_AFTER=0
      [[ -f "$WAL" ]] && WAL_AFTER=$(db_size "$WAL")
      green "  ✓ WAL checkpoint $NAME: $(to_human $WAL_BEFORE) → $(to_human $WAL_AFTER)"
      SUMMARY_LINES+=("Checkpoint $NAME: WAL $(to_human $WAL_BEFORE) → $(to_human $WAL_AFTER)")
    fi
  done
fi

# ══════════════════════════════════════════════════════════════════════
#  STEP 3: COMPACT tool outputs
# ══════════════════════════════════════════════════════════════════════
if $DO_COMPACT; then
  echo ""
  hr
  bold "Step 3: Compact Tool Outputs"
  echo "  Deletes:"
  echo "    - Tool call parts already marked as compacted by the LLM"
  echo "    - All tool call parts from sessions older than $OLDER_THAN_DAYS days"
  echo "  (Keeps recent sessions fully intact.)"
  echo ""

  for DB in "${TARGET_DBS[@]}"; do
    NAME=$(basename "$DB")
    log "Analyzing $NAME..."
    ensure_safe_to_modify "$DB" || continue

    # ── dry-run: count what would be deleted ───────────────────────
    if $DRY_RUN; then
      echo ""
      echo "  $NAME — would delete:"
      echo ""
      # Compacted parts
      COMPACTED=$(sqlite3 "$DB" "
        SELECT COUNT(*), COALESCE(SUM(LENGTH(data)), 0)
        FROM part
        WHERE json_extract(data, '$.state.time.compacted') IS NOT NULL
          AND json_extract(data, '$.type') = 'tool';
      " 2>/dev/null || echo "0|0")
      IFS='|' read -r C_COUNT C_BYTES <<< "$COMPACTED"

      # Old tool parts
      OLD_TS=$(( ($(date +%s) - OLDER_THAN_DAYS * 86400) * 1000 ))
      OLD=$(sqlite3 "$DB" "
        SELECT COUNT(*), COALESCE(SUM(LENGTH(data)), 0)
        FROM part
        WHERE json_extract(data, '$.type') = 'tool'
          AND time_created < $OLD_TS
          AND json_extract(data, '$.state.time.compacted') IS NULL;
      " 2>/dev/null || echo "0|0")
      IFS='|' read -r O_COUNT O_BYTES <<< "$OLD"

      TOTAL_PARTS=$(( C_COUNT + O_COUNT ))
      TOTAL_BYTES=$(( C_BYTES + O_BYTES ))

      echo "    • Already compacted: $C_COUNT parts = $(to_human $C_BYTES)"
      echo "    • Older than ${OLDER_THAN_DAYS}d, not yet compacted: $O_COUNT parts = $(to_human $O_BYTES)"
      echo "    ─────────────────────────────────────"
      echo "    Total: $TOTAL_PARTS parts = $(to_human $TOTAL_BYTES)"

      if [[ "$TOTAL_PARTS" -eq 0 ]]; then
        echo "    (nothing to compact)"
      else
        echo ""
        dim "    Run without --dry-run to delete these."
      fi
      echo ""
      continue
    fi

    # ── actual deletion ────────────────────────────────────────────
    confirm_step "Compact $NAME" || continue

    BEFORE=$(db_size "$DB")
    TOTAL_DELETED=0

    # 1. Delete already-compacted tool parts (safe — already summarized)
    C_COUNT=$(sqlite3 "$DB" "
      DELETE FROM part
      WHERE json_extract(data, '$.state.time.compacted') IS NOT NULL
        AND json_extract(data, '$.type') = 'tool';
      SELECT changes();
    " 2>/dev/null || echo 0)
    TOTAL_DELETED=$(( TOTAL_DELETED + C_COUNT ))

    # 2. Delete old tool parts from sessions older than threshold
    OLD_TS=$(( ($(date +%s) - OLDER_THAN_DAYS * 86400) * 1000 ))
    O_COUNT=$(sqlite3 "$DB" "
      DELETE FROM part
      WHERE json_extract(data, '$.type') = 'tool'
        AND time_created < $OLD_TS
        AND json_extract(data, '$.state.time.compacted') IS NULL;
      SELECT changes();
    " 2>/dev/null || echo 0)
    TOTAL_DELETED=$(( TOTAL_DELETED + O_COUNT ))

    if [[ "$TOTAL_DELETED" -gt 0 ]]; then
      # VACUUM to reclaim space
      sqlite3 "$DB" "VACUUM;"
      AFTER=$(db_size "$DB")
      SAVED=$(( BEFORE - AFTER ))
      green "  ✓ Compacted $NAME: deleted $TOTAL_DELETED parts, $(to_human $SAVED) reclaimed"
      SUMMARY_LINES+=("Compact $NAME: deleted $TOTAL_DELETED parts, freed $(to_human $SAVED)")
    else
      echo "  $NAME: nothing to compact"
    fi
  done
fi

# ══════════════════════════════════════════════════════════════════════
#  STEP 4: Clean old sessions (direct SQLite — all projects)
# ══════════════════════════════════════════════════════════════════════
if $DO_CLEAN_SESSIONS; then
  echo ""
  hr
  bold "Step 4: Clean Old Sessions"
  echo "  Finds root sessions (no parent) older than $OLDER_THAN_DAYS days across ALL databases."
  echo "  Archives then deletes them (cascade removes messages + parts)."
  echo "  Child sessions are deleted before parents."
  echo ""

  CUTOFF_TS=$(( ($(date +%s) - OLDER_THAN_DAYS * 86400) * 1000 ))
  TOTAL_DELETED=0

  for DB in "${TARGET_DBS[@]}"; do
    NAME=$(basename "$DB")

    if ! sqlite3 "$DB" "SELECT count(*) FROM session;" &>/dev/null; then
      echo "  $NAME: not accessible — skipping"
      continue
    fi

    # Find old root sessions (no parent, not already archived, not updated since cutoff)
    OLD_ROOTS=$(sqlite3 "$DB" "
      SELECT id, time_created, time_updated, COALESCE(NULLIF(title,''), '(untitled)') 
      FROM session 
      WHERE parent_id IS NULL 
        AND time_updated < $CUTOFF_TS 
        AND time_archived IS NULL 
      ORDER BY time_updated;
    " 2>/dev/null || echo "")

    if [[ -z "$OLD_ROOTS" ]]; then
      echo "  $NAME: no old sessions found"
      continue
    fi

    # Count roots
    ROOT_COUNT=$(echo "$OLD_ROOTS" | wc -l | tr -d ' ')
    echo "  $NAME: $ROOT_COUNT root session(s) older than ${OLDER_THAN_DAYS}d"

    if ! $DRY_RUN; then
      echo "  Session IDs:"
    fi
    echo "$OLD_ROOTS" | while IFS='|' read -r ID CREATED UPDATED TITLE; do
      CREATED_STR=$(date -r $((CREATED/1000)) '+%Y-%m-%d' 2>/dev/null || echo "$CREATED")
      TRUNC_TITLE="${TITLE:0:50}"
      if $DRY_RUN; then
        dim "    [dry-run] ${ID:0:20}  $CREATED_STR  $TRUNC_TITLE"
      else
        echo "    ${ID:0:20}  $CREATED_STR  $TRUNC_TITLE"
      fi
    done

    # ── dry-run: stop here ─────────────────────────────────────────
    if $DRY_RUN; then
      ROOT_IDS=$(echo "$OLD_ROOTS" | cut -d'|' -f1 | tr '\n' ',' | sed 's/,$//')
      if [[ -n "$ROOT_IDS" ]]; then
        CHILD_COUNT=$(sqlite3 "$DB" "
          SELECT count(*) FROM session 
          WHERE parent_id IN ($(echo "$ROOT_IDS" | sed "s/,/','/g; s/^/'/; s/$/'/"))
            AND time_archived IS NULL;
        " 2>/dev/null || echo 0)
        echo "    (plus $CHILD_COUNT child session(s) that would also be deleted)"
      fi
      continue
    fi

    # ── actual deletion ────────────────────────────────────────────
    confirm_step "Delete sessions older than ${OLDER_THAN_DAYS}d from $NAME" || continue

    # Build a quoted, comma-separated list of IDs for SQL IN clause
    ROOT_IDS=$(echo "$OLD_ROOTS" | cut -d'|' -f1 | tr '\n' ',' | sed 's/,$//')
    ROOT_IDS_SQL=$(echo "$ROOT_IDS" | sed "s/,/','/g; s/^/'/; s/$/'/")

    # Step A: Archive these root sessions
    sqlite3 "$DB" "
      UPDATE session SET time_archived = $(date +%s%3N)
      WHERE id IN ($ROOT_IDS_SQL);
    " 2>/dev/null || { echo "    ✗ Archive failed for $NAME"; continue; }

    # Step B: Recursively find all children of these roots (any depth)
    # SQLite recursive CTE to find all descendant session IDs
    ALL_IDS=$(sqlite3 "$DB" "
      WITH RECURSIVE descendent_ids(id) AS (
        SELECT id FROM session WHERE id IN ($ROOT_IDS_SQL)
        UNION ALL
        SELECT s.id FROM session s JOIN descendent_ids d ON s.parent_id = d.id
      )
      SELECT id FROM descendent_ids;
    " 2>/dev/null || echo "$ROOT_IDS")

    ALL_IDS_SQL=$(echo "$ALL_IDS" | tr '\n' ',' | sed 's/,$//' | sed "s/,/','/g; s/^/'/; s/$/'/")

    # Step C: Delete messages (cascades to parts via ON DELETE CASCADE)
    MSG_COUNT=$(sqlite3 "$DB" "
      DELETE FROM message WHERE session_id IN ($ALL_IDS_SQL);
      SELECT changes();
    " 2>/dev/null || echo 0)

    # Step D: Delete children first, then roots (no FK cascade on parent_id)
    sqlite3 "$DB" "
      DELETE FROM session WHERE parent_id IN ($ROOT_IDS_SQL);
    " 2>/dev/null

    sqlite3 "$DB" "
      DELETE FROM session WHERE id IN ($ROOT_IDS_SQL);
    " 2>/dev/null

    TOTAL_DELETED=$(( TOTAL_DELETED + ROOT_COUNT ))
    green "  ✓ $NAME: archived + deleted $ROOT_COUNT root session(s), $MSG_COUNT messages"
    SUMMARY_LINES+=("Clean sessions $NAME: deleted $ROOT_COUNT session(s) older than ${OLDER_THAN_DAYS}d")
  done

  if $DRY_RUN; then
    echo ""
    dim "  (dry-run — would delete matching sessions when run without --dry-run)"
  fi
fi

# ══════════════════════════════════════════════════════════════════════
#  STEP 5: Clean stale DB files
# ══════════════════════════════════════════════════════════════════════
if $DO_CLEAN_STALE; then
  echo ""
  hr
  bold "Step 5: Clean Stale Database Files"
  echo "  Removes old opencode DB files no longer in use:"
  echo "    - opencode-260430-initial-build.db (~4.4 MB)"
  echo "    - opencode-patched-dev.db (~15 MB)"
  echo ""

  STALE_PATTERNS=(
    "opencode-260430-initial-build.db"
    "opencode-patched-dev.db"
  )

  STALE_FILES=()
  for PATTERN in "${STALE_PATTERNS[@]}"; do
    while IFS= read -r -d '' f; do
      [[ -f "$f" ]] && STALE_FILES+=("$f")
    done < <(find "$DATA_DIR" -maxdepth 1 -name "$PATTERN*" -print0 2>/dev/null || true)
  done

  if [[ ${#STALE_FILES[@]} -eq 0 ]]; then
    echo "  No stale database files found."
  else
    echo "  Stale files to remove:"
    TOTAL_STALE=0
    for F in "${STALE_FILES[@]}"; do
      [[ -f "$F" ]] || continue
      SIZE=$(db_size "$F")
      TOTAL_STALE=$(( TOTAL_STALE + SIZE ))
      echo "    $(basename "$F") — $(to_human $SIZE)"
    done

    echo ""
    log "Remove $TOTAL_STALE bytes of stale DB files?"

    if $DRY_RUN; then
      dim "    (dry-run — would remove $(to_human $TOTAL_STALE))"
    else
      confirm_step "Remove stale DB files" || continue
      REMOVED=0
      for F in "${STALE_FILES[@]}"; do
        [[ -f "$F" ]] || continue
        rm -v "$F" && REMOVED=$(( REMOVED + 1 ))
      done
      green "  ✓ Removed $REMOVED stale files, freed $(to_human $TOTAL_STALE)"
      SUMMARY_LINES+=("Clean stale: removed $REMOVED files, freed $(to_human $TOTAL_STALE)")
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════════════
#  SUMMARY
# ══════════════════════════════════════════════════════════════════════
if $DRY_RUN; then
  echo ""
  hr
  bold "DRY RUN COMPLETE"
  echo "  Run without --dry-run to apply changes."
else
  echo ""
  hr
  bold "SUMMARY"
  if [[ ${#SUMMARY_LINES[@]} -eq 0 ]]; then
    echo "  Nothing was done."
  else
    for LINE in "${SUMMARY_LINES[@]}"; do
      green "  ✓ $LINE"
    done
  fi
  echo ""
  echo "Next:"
  echo "  ./scripts/opencode-db-stats.sh   # verify results"
  echo ""
fi

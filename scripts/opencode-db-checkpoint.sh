#!/bin/bash
# opencode-db-checkpoint.sh — Quick WAL checkpoint for opencode databases
#
# Truncates WAL journals and sets journal_size_limit to prevent unbounded
# WAL growth during active sessions. Safe to run while opencode is running
# (TRUNCATE mode falls back to PASSIVE if there are active readers).
#
# Usage:
#   ./scripts/opencode-db-checkpoint.sh                    # checkpoint all opencode DBs
#   ./scripts/opencode-db-checkpoint.sh --db opencode-local.db  # checkpoint one DB

set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
JOURNAL_LIMIT=16777216  # 16 MB
RAN_ANY=false

# ── helpers ──────────────────────────────────────────────────────────
to_human() {
  if command -v numfmt &>/dev/null; then numfmt --to=iec "$1"
  elif command -v perl &>/dev/null; then
    perl -e 'my $b=shift; my @u=("B","KB","MB","GB"); my $i=0; while($b>1024 && $i<3){$b/=1024;$i++} printf("%.1f %s\n",$b,$u[$i])' "$1"
  else echo "${1}B"
  fi
}

# ── parse args ────────────────────────────────────────────────────────
DB_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_NAME="$2"; shift ;;
    --help|-h)
      sed -n '/^# Usage:/,//p' "$0" | sed -n '2,/^$/p' | sed 's/^# //'
      exit 0 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
  shift
done

# ── find DB files ────────────────────────────────────────────────────
if [[ -n "$DB_NAME" ]]; then
  TARGET="$DATA_DIR/$DB_NAME"
  if [[ ! -f "$TARGET" ]]; then echo "Not found: $TARGET"; exit 1; fi
  DB_FILES=("$TARGET")
else
  DB_FILES=()
  while IFS= read -r -d '' f; do
    case "$(basename "$f")" in
      *.db-wal|*.db-shm) continue ;;
      opencode*.db) DB_FILES+=("$f") ;;
    esac
  done < <(find "$DATA_DIR" -maxdepth 1 -name 'opencode*.db' -print0 2>/dev/null)
fi

if [[ ${#DB_FILES[@]} -eq 0 ]]; then
  echo "No opencode databases found in $DATA_DIR"
  exit 1
fi

echo "WAL Checkpoint — $(date '+%Y-%m-%d %H:%M')"
echo ""

for DB in "${DB_FILES[@]}"; do
  NAME=$(basename "$DB")
  WAL="${DB}-wal"
  WAL_BEFORE=0
  [[ -f "$WAL" ]] && WAL_BEFORE=$(stat -f%z "$WAL" 2>/dev/null || stat -c%s "$WAL" 2>/dev/null || echo 0)

  echo "  $NAME"

  # Set journal_size_limit (persistent)
  sqlite3 "$DB" "PRAGMA journal_size_limit = $JOURNAL_LIMIT;" 2>/dev/null || { echo "    ✗ Error accessing $NAME"; continue; }
  echo "    journal_size_limit → $(to_human $JOURNAL_LIMIT)"

  # Checkpoint with truncation
  RESULT=$(sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || echo "")
  echo "    Checkpoint result: $RESULT"

  WAL_AFTER=0
  [[ -f "$WAL" ]] && WAL_AFTER=$(stat -f%z "$WAL" 2>/dev/null || stat -c%s "$WAL" 2>/dev/null || echo 0)

  if [[ "$WAL_BEFORE" -eq 0 && "$WAL_AFTER" -eq 0 ]]; then
    :  # no WAL file exists
  elif [[ "$WAL_BEFORE" -eq "$WAL_AFTER" ]]; then
    echo "    WAL: $(to_human $WAL_BEFORE) (unchanged — possibly in use)"
  else
    echo "    WAL: $(to_human $WAL_BEFORE) → $(to_human $WAL_AFTER)"
  fi
  echo ""
  RAN_ANY=true
done

if ! $RAN_ANY; then
  echo "Nothing done."
fi

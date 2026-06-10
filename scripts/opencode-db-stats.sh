#!/bin/bash
# opencode-db-stats.sh — Show database sizes, table stats, and estimated reclaimable space
#
# Usage:
#   ./scripts/opencode-db-stats.sh                  # stats for all opencode DBs
#   ./scripts/opencode-db-stats.sh --db opencode-local.db  # stats for one DB only
#
# Requirements: sqlite3, opencode CLI

set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"

# ── helpers ─────────────────────────────────────────────────────────
hr() { printf '%*s\n' "${1:-60}" '' | tr ' ' '─'; }
to_human() {
  # Converts bytes to human-readable (requires GNU numfmt or fallback)
  if command -v numfmt &>/dev/null; then
    numfmt --to=iec "$1"
  elif command -v perl &>/dev/null; then
    perl -e 'my $b=shift; my @u=("B","KB","MB","GB"); my $i=0; while($b>1024 && $i<3){$b/=1024;$i++} printf("%.1f %s\n",$b,$u[$i])' "$1"
  else
    echo "${1}B"
  fi
}

# ── find DB files ────────────────────────────────────────────────────
DB_FILES=()
while IFS= read -r -d '' f; do
  # Skip WAL/SHM journals
  case "$f" in
    *.db-wal|*.db-shm) continue ;;
    *.db) DB_FILES+=("$f") ;;
  esac
done < <(find "$DATA_DIR" -maxdepth 1 -name 'opencode*.db' -print0 2>/dev/null)

if [[ ${#DB_FILES[@]} -eq 0 ]]; then
  echo "No opencode databases found in $DATA_DIR"
  exit 1
fi

echo "═════════════════════════════════════════════════════════"
echo "  OpenCode Database Stats"
echo "  Data dir: $DATA_DIR"
echo "═════════════════════════════════════════════════════════"
echo ""

TOTAL_SIZE=0
for DB in "${DB_FILES[@]}"; do
  NAME=$(basename "$DB")
  SIZE=$(stat -f%z "$DB" 2>/dev/null || stat -c%s "$DB" 2>/dev/null || echo 0)
  TOTAL_SIZE=$((TOTAL_SIZE + SIZE))

  # WAL size
  WAL="${DB}-wal"
  WAL_SIZE=0
  [[ -f "$WAL" ]] && WAL_SIZE=$(stat -f%z "$WAL" 2>/dev/null || stat -c%s "$WAL" 2>/dev/null || echo 0)

  echo "── $NAME ──"
  echo "  File size:     $(to_human $SIZE)"
  echo "  WAL size:      $(to_human $WAL_SIZE)"
  echo "  Last modified: $(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$DB" 2>/dev/null || date -r "$DB" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')"

  # ── table-level stats ────────────────────────────────────────────
  if [[ -s "$DB" ]]; then
    # Use a temporary DB to avoid corrupting WAL
    TMP=$(mktemp)
    # Copy to temp to avoid locks on the live DB
    sqlite3 "$DB" ".clone $TMP" 2>/dev/null || { echo "  (locked by opencode — skipping table stats)"; rm -f "$TMP"; continue; }

    echo "  Table stats:"
    while IFS='|' read -r TABLE ROWS; do
      echo "    $TABLE: $ROWS rows"
    done < <(sqlite3 "$TMP" "
      SELECT 'session',  COUNT(*) FROM session;
      SELECT 'message',  COUNT(*) FROM message;
      SELECT 'part',     COUNT(*) FROM part;
    " 2>/dev/null || echo "part|0")

    # Free pages
    FREE_PAGES=$(sqlite3 "$TMP" "PRAGMA freelist_count;" 2>/dev/null || echo 0)
    if [[ "$FREE_PAGES" -gt 0 ]]; then
      FREE_MB=$(( FREE_PAGES * 4096 ))
      echo "  Free pages:    $FREE_PAGES ($(to_human $FREE_MB) reclaimable via VACUUM)"
    fi

    # Oldest session
    OLDEST=$(sqlite3 "$TMP" "SELECT MIN(time_created) FROM session;" 2>/dev/null || echo "")
    NEWEST=$(sqlite3 "$TMP" "SELECT MAX(time_created) FROM session;" 2>/dev/null || echo "")
    COUNT=$(sqlite3 "$TMP" "SELECT COUNT(*) FROM session;" 2>/dev/null || echo 0)
    if [[ -n "$OLDEST" && "$OLDEST" != "" ]]; then
      OLDEST_DATE=$(date -r $((OLDEST/1000)) '+%Y-%m-%d' 2>/dev/null || echo "$OLDEST")
      NEWEST_DATE=$(date -r $((NEWEST/1000)) '+%Y-%m-%d' 2>/dev/null || echo "$NEWEST")
      echo "  Sessions:      $COUNT (from $OLDEST_DATE to $NEWEST_DATE)"
    fi

    rm -f "$TMP"
  fi
  echo ""
done

echo "═════════════════════════════════════════════════════════"
echo "  Total DB size: $(to_human $TOTAL_SIZE)"
echo "═════════════════════════════════════════════════════════"
echo ""
echo "Quick tips:"
echo "  ./scripts/opencode-db-cleanup.sh --dry-run   # preview what can be cleaned"
echo "  ./scripts/opencode-db-cleanup.sh             # interactive cleanup"
echo ""

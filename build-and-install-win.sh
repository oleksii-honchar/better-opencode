#!/usr/bin/env bash
# build-and-install-win.sh — Build better-opencode fork and install binary on Windows (GitBash)
#
# Usage:
#   ./build-and-install-win.sh --install --clean          # Full build + install
#   ./build-and-install-win.sh --only-build                # Build only (skip binary install)
#   ./build-and-install-win.sh --clean                     # Clean dist/ before build
#
# Dry-run (print the commands instead of executing them):
#   DRY_RUN=1 ./build-and-install-win.sh --install
#
# This script:
#   1. Builds from current branch (no git operations)
#   2. Runs bun install, then the opencode build (win32-x64 target)
#   3. Installs forked binary to ~/bin/better-opencode.exe (NOT replacing any system opencode)
#
# Note: Git operations (fetch, rebase, checkout) are intentionally excluded.
# Use the script to build from whatever branch you're currently on.

set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
# The build pipeline names win32 targets as "windows" (see packages/opencode/script/build.ts:
# `item.os === "win32" ? "windows" : item.os`), and bun emits the Windows binary as opencode.exe.
BINARY_SOURCE="$FORK_DIR/packages/opencode/dist/opencode-windows-x64/bin/opencode.exe"
BETTER_OPENCODE_BIN="$HOME/bin/better-opencode.exe"

INSTALL=false
ONLY_BUILD=false
CLEAN=false
DRY_RUN="${DRY_RUN:-0}"

# Run or print a command depending on DRY_RUN
run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY_RUN: $*"
  else
    "$@"
  fi
}

# Parse flags
for arg in "$@"; do
  case $arg in
    --install) INSTALL=true ;;
    --only-build) ONLY_BUILD=true ;;
    --clean) CLEAN=true ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --install              Install forked binary to ~/bin/better-opencode.exe"
      echo "  --only-build           Skip binary install (build only)"
      echo "  --clean                Remove dist/ before building"
      echo ""
      echo "Environment:"
      echo "  DRY_RUN=1              Print the commands instead of executing them"
      echo ""
      echo "Examples:"
      echo "  $0 --install --clean              # Full build + install"
      echo "  $0 --only-build                   # Build only, no install"
      echo "  DRY_RUN=1 $0 --install            # Preview the commands"
      echo ""
      echo "Note: No git operations (fetch, rebase, checkout). Builds from current branch."
      echo "Hint: On Win11 you can pass --single to the build for a faster target-only build."
      exit 0
      ;;
  esac
done

if [ ! -d "$FORK_DIR" ]; then
  echo "ERROR: Fork not found at $FORK_DIR"
  exit 1
fi

cd "$FORK_DIR"

# Prereq: bun must be on PATH
if ! command -v bun &> /dev/null; then
  echo "ERROR: bun not found on PATH."
  echo "Install it via Chocolatey (recommended):"
  echo "  choco install -y bun"
  echo "Then restart GitBash (so PATH refreshes) and re-run this script."
  exit 1
fi

# Show current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "=== Current branch: $CURRENT_BRANCH ==="

# Build path — no git operations, build from current branch
echo "=== Running bun install ==="
run bun install --quiet

echo "=== Building opencode binary (win32-x64) ==="
if [ "$CLEAN" = true ]; then
  echo "  Cleaning dist/ directory"
  run rm -rf "$FORK_DIR/packages/opencode/dist"
fi

# Tip: add `--single` on Win11 to build only the current (win32-x64) target for speed.
run bun run --cwd packages/opencode build

if [ ! -f "$BINARY_SOURCE" ] && [ "$DRY_RUN" != "1" ]; then
  echo "ERROR: Binary not found at $BINARY_SOURCE"
  echo "The win32-x64 build may not have produced the expected artifact."
  exit 1
fi

if [ "$ONLY_BUILD" = true ]; then
  echo "=== Build complete (no install) ==="
  echo "  Binary: $BINARY_SOURCE"
  exit 0
fi

if [ "$INSTALL" = true ]; then
  echo "=== Installing forked binary to ~/bin/better-opencode.exe ==="
  run mkdir -p "$HOME/bin"
  run cp "$BINARY_SOURCE" "$BETTER_OPENCODE_BIN"
  run chmod +x "$BETTER_OPENCODE_BIN"

  # Verify the binary exists (skip the actual check in dry-run; we only print)
  if [ "$DRY_RUN" = "1" ]; then
    run test -f "$BETTER_OPENCODE_BIN"
  else
    if [ ! -f "$BETTER_OPENCODE_BIN" ]; then
      echo "ERROR: Installation failed, binary not found at $BETTER_OPENCODE_BIN"
      exit 1
    fi
  fi

  # Print a Windows-native path so native Windows users see the right location
  echo ""
  if [ "$DRY_RUN" = "1" ]; then
    # Always show the cygpath verification command in dry-run
    echo "DRY_RUN: WIN_PATH=\$(cygpath -w \"$BETTER_OPENCODE_BIN\")"
  elif command -v cygpath &> /dev/null; then
    WIN_PATH=$(cygpath -w "$BETTER_OPENCODE_BIN")
    echo "  Binary installed (Windows path): $WIN_PATH"
  else
    echo "  Binary installed: $BETTER_OPENCODE_BIN"
    echo "  (cygpath not available on this host; on Windows use: cygpath -w \"$BETTER_OPENCODE_BIN\")"
  fi

  echo ""
  echo "=== Verify from native Windows (PowerShell/CMD) ==="
  echo "  where better-opencode.exe"
  echo "  C:\\Users\\<you>\\bin\\better-opencode.exe --version"
  echo ""
  echo "  Point the better-openchamber extension at this binary via its"
  echo "  'opencodeBinary' setting (Windows path, see cygpath output above)."
  echo ""
  echo "  Build and install complete"
else
  echo "=== Build complete (no install; pass --install to install) ==="
  echo "  Binary: $BINARY_SOURCE"
fi

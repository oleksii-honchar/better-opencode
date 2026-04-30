#!/bin/bash
# build-and-install.sh — Build better-opencode fork and optionally install binary
#
# Usage:
#   ./build-and-install.sh --install --clean          # Full build + install + configure OpenChamber
#   ./build-and-install.sh --only-build                # Build only (skip binary install)
#   ./build-and-install.sh --clean                     # Clean dist/ before build
#   ./build-and-install.sh --configure-openchamber     # Configure OpenChamber only (no build)
#   ./build-and-install.sh --unconfigure-openchamber   # Remove OpenChamber config (undo)
#
# This script:
#   1. Builds from current branch (no git operations)
#   2. Runs bun install, typecheck, and build
#   3. Installs forked binary to ~/bin/better-opencode (NOT replacing Homebrew)
#   4. Configures OpenChamber to use the forked binary (optional, can be done standalone)
#
# Note: Git operations (fetch, rebase, checkout) are intentionally excluded.
# Use the script to build from whatever branch you're currently on.

set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY_SOURCE="$FORK_DIR/packages/opencode/dist/opencode-darwin-arm64/bin/opencode"
BETTER_OPENCODE_BIN="$HOME/bin/better-opencode"
OPENCHAMBER_SETTINGS="$HOME/.config/openchamber/settings.json"

INSTALL=false
ONLY_BUILD=false
CLEAN=false
CONFIGURE_OPENCHAMBER=false
UNCONFIGURE_OPENCHAMBER=false

# Parse flags
for arg in "$@"; do
  case $arg in
    --install) INSTALL=true ;;
    --only-build) ONLY_BUILD=true ;;
    --clean) CLEAN=true ;;
    --configure-openchamber) CONFIGURE_OPENCHAMBER=true ;;
    --unconfigure-openchamber) UNCONFIGURE_OPENCHAMBER=true ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Build options:"
      echo "  --install              Install forked binary to ~/bin/better-opencode + configure OpenChamber"
      echo "  --only-build           Skip binary install and OpenChamber config (build only)"
      echo "  --clean                Remove dist/ before building"
      echo ""
      echo "OpenChamber options (can be used standalone or with --install):"
      echo "  --configure-openchamber  Configure OpenChamber to use forked binary"
      echo "  --unconfigure-openchamber  Remove OpenChamber config (switch back to Homebrew opencode)"
      echo ""
      echo "Examples:"
      echo "  $0 --install --clean              # Full build + install + configure"
      echo "  $0 --only-build                   # Build only, no install"
      echo "  $0 --configure-openchamber        # Configure OpenChamber only (no build)"
      echo "  $0 --unconfigure-openchamber      # Remove OpenChamber config"
      echo ""
      echo "Note: No git operations (fetch, rebase, checkout). Builds from current branch."
      exit 0
      ;;
  esac
done

if [ ! -d "$FORK_DIR" ]; then
  echo "ERROR: Fork not found at $FORK_DIR"
  exit 1
fi

cd "$FORK_DIR"

# Show current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "=== Current branch: $CURRENT_BRANCH ==="

# OpenChamber configuration helper functions
configure_openchamber() {
  local bin_path="$1"
  echo "=== Configuring OpenChamber settings.json ==="
  if [ -f "$OPENCHAMBER_SETTINGS" ]; then
    # Use jq to update opencodeBinary if available, otherwise use sed
    if command -v jq &> /dev/null; then
      echo "  Using jq to update settings.json"
      jq '. + {"opencodeBinary": "'"$bin_path"'"}' "$OPENCHAMBER_SETTINGS" > "${OPENCHAMBER_SETTINGS}.tmp"
      mv "${OPENCHAMBER_SETTINGS}.tmp" "$OPENCHAMBER_SETTINGS"
    else
      echo "  jq not found — checking if opencodeBinary already exists"
      if grep -q '"opencodeBinary"' "$OPENCHAMBER_SETTINGS"; then
        echo "  Updating existing opencodeBinary value"
        sed -i '' "s|\"opencodeBinary\":.*|\"opencodeBinary\": \"$bin_path\",|" "$OPENCHAMBER_SETTINGS"
      else
        echo "  Adding opencodeBinary to settings.json"
        # Insert before the closing brace
        sed -i '' "s/}$/,\"opencodeBinary\": \"$bin_path\"}/" "$OPENCHAMBER_SETTINGS"
      fi
    fi
    echo "  Settings updated: $OPENCHAMBER_SETTINGS"
  else
    echo "  WARNING: OpenChamber settings not found at $OPENCHAMBER_SETTINGS"
    echo "  Manual configuration needed: add \"opencodeBinary\": \"$bin_path\" to settings.json"
  fi
}

unconfigure_openchamber() {
  echo "=== Removing OpenChamber opencodeBinary config ==="
  if [ -f "$OPENCHAMBER_SETTINGS" ]; then
    if command -v jq &> /dev/null; then
      echo "  Using jq to remove opencodeBinary"
      jq 'del(.opencodeBinary)' "$OPENCHAMBER_SETTINGS" > "${OPENCHAMBER_SETTINGS}.tmp"
      mv "${OPENCHAMBER_SETTINGS}.tmp" "$OPENCHAMBER_SETTINGS"
    else
      echo "  jq not found — using sed to remove opencodeBinary"
      sed -i '' '/"opencodeBinary"/d' "$OPENCHAMBER_SETTINGS"
      # Clean up trailing comma if present
      sed -i '' 's/,\s*}/}/' "$OPENCHAMBER_SETTINGS"
    fi
    echo "  opencodeBinary removed from $OPENCHAMBER_SETTINGS"
  else
    echo "  WARNING: OpenChamber settings not found at $OPENCHAMBER_SETTINGS"
  fi
  echo ""
  echo "  To fully switch back to Homebrew opencode, also remove:"
  echo "    export OPENCHAMBER_OPENCODE_PATH=\"$BETTER_OPENCODE_BIN\"  # from ~/.zshrc"
}

# Handle unconfigure standalone (no build needed)
if [ "$UNCONFIGURE_OPENCHAMBER" = true ]; then
  unconfigure_openchamber
  echo "Done. OpenChamber will now use the default opencode (Homebrew or PATH)."
  exit 0
fi

# Handle configure-only standalone (no build needed)
if [ "$CONFIGURE_OPENCHAMBER" = true ]; then
  if [ "$INSTALL" = true ]; then
    echo "=== Installing forked binary to ~/bin/better-opencode ==="
    mkdir -p "$HOME/bin"
    cp "$BINARY_SOURCE" "$BETTER_OPENCODE_BIN"
    chmod +x "$BETTER_OPENCODE_BIN"
    echo "  Binary: $BETTER_OPENCODE_BIN"
  fi
  configure_openchamber "$BETTER_OPENCODE_BIN"
  echo ""
  echo "=== CLI script env var recommendation ==="
  echo "  Add to ~/.zshrc: export OPENCHAMBER_OPENCODE_PATH=\"$BETTER_OPENCODE_BIN\""
  echo "  (This ensures the CLI script also uses the forked binary)"
  echo ""
  echo "OpenChamber configuration complete ✓"
  exit 0
fi

# Build path — no git operations, build from current branch
echo "=== Running bun install ==="
bun install --quiet

echo "=== Running bun turbo typecheck ==="
bun turbo typecheck || {
  echo "ERROR: typecheck failed"
  exit 1
}

echo "=== Building opencode binary ==="
if [ "$CLEAN" = true ]; then
  echo "  Cleaning dist/ directory"
  rm -rf "$FORK_DIR/packages/opencode/dist"
fi

bun run --cwd packages/opencode build

if [ ! -f "$BINARY_SOURCE" ]; then
  echo "ERROR: Binary not found at $BINARY_SOURCE"
  exit 1
fi

if [ "$ONLY_BUILD" = false ]; then
  if [ "$INSTALL" = true ]; then
    echo "=== Installing forked binary to ~/bin/better-opencode ==="
    mkdir -p "$HOME/bin"
    cp "$BINARY_SOURCE" "$BETTER_OPENCODE_BIN"
    chmod +x "$BETTER_OPENCODE_BIN"
    echo "  Binary: $BETTER_OPENCODE_BIN"

    configure_openchamber "$BETTER_OPENCODE_BIN"

    echo "=== CLI script env var recommendation ==="
    echo "  Add to ~/.zshrc: export OPENCHAMBER_OPENCODE_PATH=\"$BETTER_OPENCODE_BIN\""
    echo "  (This ensures the CLI script also uses the forked binary)"

    echo "=== Smoke test ==="
    "$BETTER_OPENCODE_BIN" --version
    echo "  Build and install complete ✓"
  else
    echo "=== Build complete (no install) ==="
    echo "  Binary: $BINARY_SOURCE"
  fi
fi

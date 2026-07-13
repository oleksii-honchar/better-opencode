#!/bin/bash
# start-dev.sh — better-opencode dev server + OpenChamber (VSCodium / VS Code)
#
# Two tabs (only supported workflow):
#   Tab A: ./scripts/start-dev.sh              # foreground bun server; Ctrl+C stops
#   Tab B: ./scripts/start-dev.sh --ide-only   # launch IDE with OPENCODE_* env
#
#   ./scripts/start-dev.sh --stop              # kill whatever listens on OPENCODE_PORT
#   ./scripts/start-dev.sh --port 5000 ...
#
# Requirements:
#   - better-opencode at ~/www/misc/better-opencode
#   - openchamber VSCode extension installed
#   - bun installed
#   - IDE (VSCode/VSCodium) must be CLOSED before running this script

set -euo pipefail

# Auto-detect repo root from script location; override via BETTER_OPENCODE_DIR env var
BETTER_OPENCODE_DIR="${BETTER_OPENCODE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"
VSCODE_DIR="${VSCODE_DIR:-.}"

# VSCode variant - defaults to VSCodium, can be overridden with --vscode or VSCODE_APP env var
VSCODE_APP="${VSCODE_APP:-codium}"  # codium = VSCodium

# Parse arguments  (default: run dev server in foreground)
STOP=false
FORCE=false
MODE=server
SERVER_LOGS=false
TOOL_LOGS=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --server-only)
      if [ "$MODE" = "ide-only" ]; then
        echo "ERROR: use only one of default/--server-only or --ide-only" >&2
        exit 1
      fi
      MODE=server
      shift
      ;;
    --ide-only)
      if [ "$MODE" = "ide-only" ]; then
        echo "ERROR: duplicate --ide-only" >&2
        exit 1
      fi
      MODE=ide-only
      shift
      ;;
    --stop|-s)
      STOP=true
      shift
      ;;
    --port)
      OPENCODE_PORT="$2"
      shift 2
      ;;
    --vscode)
      VSCODE_APP="code"
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --server-logs)
      SERVER_LOGS=true
      shift
      ;;
    --tool-logs)
      TOOL_LOGS=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --stop, -s    Stop the better-opencode dev server"
      echo "  --port NUM    Port for dev server (default: 4096)"
      echo "  --vscode      Use VSCode instead of VSCodium (default: VSCodium)"
      echo "  --server-only Same as default: run dev server in foreground (this tab)"
      echo "  --server-logs Tail dev server logs (requires running server)"
      echo "  --tool-logs   Tail tool execution logs (requires running server)"
      echo "  --ide-only    Other tab: launch IDE; server must already listen on OPENCODE_PORT"
      echo "  --force       Force launch even if $VSCODE_APP is detected as running"
      echo "  --help, -h    Show this help message"
      echo ""
      echo "Environment variables:"
      echo "  BETTER_OPENCODE_DIR  Path to better-opencode (default: ~/www/misc/better-opencode)"
      echo "  OPENCODE_PORT        Port for dev server (default: 4096)"
      echo "  NODE_EXTRA_CA_CERTS  PEM for internal HTTPS (Caddy, etc.); macOS Keychain alone is not enough for Bun"
      echo "  VSCODE_APP           VSCode variant: 'codium' (VSCodium) or 'code' (VSCode)"
      echo "  VSCODIUM_APP         macOS: path to bundle, e.g. /Applications/VSCodium.app (optional)"
      echo "  VSCODIUM_APP_NAME    macOS: app name for open -a if bundle path fails (optional)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Bun/Node TLS does not use macOS Keychain. HTTPS to Caddy/internal hosts (e.g. lite-lm) needs a PEM bundle:
#   export NODE_EXTRA_CA_CERTS=/path/to/your-root-or-chain.pem
# Or place that PEM at ~/.config/better-opencode/extra-ca.pem (loaded below when NODE_EXTRA_CA_CERTS is unset).
EXTRA_CA_FALLBACK="${HOME}/.config/better-opencode/extra-ca.pem"
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$EXTRA_CA_FALLBACK" ]; then
  export NODE_EXTRA_CA_CERTS="$EXTRA_CA_FALLBACK"
fi

LEGACY_PID_FILE="$HOME/.local/share/better-opencode-dev.pid"

mkdir -p "$HOME/.local/share"

curl_global_health() {
  curl -sf "http://127.0.0.1:${OPENCODE_PORT}/global/health"
}

# Do not use `curl_global_health | grep -q` with `set -o pipefail`: grep exits after match,
# curl gets SIGPIPE → pipeline fails even when the server returned healthy JSON.
curl_global_health_ok() {
  local body
  body=$(curl_global_health 2>/dev/null) || return 1
  [[ "$body" == *'"healthy":true'* ]]
}

# macOS VSCodium.app locations (single source of truth for bundle iteration below).
_vscodium_macos_bundle_dirs() {
  [ -n "${VSCODIUM_APP:-}" ] && printf '%s\n' "$VSCODIUM_APP"
  printf '%s\n' "/Applications/VSCodium.app" "$HOME/Applications/VSCodium.app"
}

# macOS: `open -a` does not pass env into the GUI. Launch the bundle binary so OPENCODE_PORT reaches the app.
launch_vscodium_macos_with_env() {
  local dir="$1"
  local bundle exe
  while IFS= read -r bundle; do
    [ -n "$bundle" ] || continue
    [ -d "$bundle" ] || continue
    for exe in "$bundle/Contents/MacOS/VSCodium" "$bundle/Contents/MacOS/Electron"; do
      if [ -x "$exe" ]; then
        env -u OPENCODE_SERVER_PASSWORD OPENCODE_PORT="$OPENCODE_PORT" \
          "$exe" "$dir"
        return 0
      fi
    done
  done < <(_vscodium_macos_bundle_dirs)

  echo "  NOTE: VSCodium bundle binary not found; falling back to open -a (OpenChamber may start its own server)." >&2
  open_codium_on_macos "$dir"
}

# macOS: open the .app bundle directly — no `codium` CLI required (no OPENCODE_*; prefer launch_vscodium_macos_with_env).
open_codium_on_macos() {
  local dir="$1"
  local bundle app
  while IFS= read -r bundle; do
    [ -n "$bundle" ] || continue
    [ -d "$bundle" ] || continue
    if open -a "$bundle" "$dir" 2>/dev/null; then
      echo "  Launched $bundle (open -a; no CLI needed)"
      return 0
    fi
  done < <(_vscodium_macos_bundle_dirs)

  if [ -n "${VSCODIUM_APP_NAME:-}" ]; then
    if open -a "$VSCODIUM_APP_NAME" "$dir" 2>/dev/null; then
      echo "  Launched \"$VSCODIUM_APP_NAME\" (VSCODIUM_APP_NAME)"
      return 0
    fi
  fi

  for app in "VSCodium" "VSCodium - Insiders" "VSCodeVodium"; do
    if open -a "$app" "$dir" 2>/dev/null; then
      echo "  Launched \"$app\" (open -a)"
      return 0
    fi
  done
  return 1
}

if [ "$STOP" = true ]; then
  echo "Stopping listener(s) on port $OPENCODE_PORT..."
  rm -f "$LEGACY_PID_FILE"
  if command -v lsof &> /dev/null; then
    if lsof -nP -iTCP:"$OPENCODE_PORT" -sTCP:LISTEN &> /dev/null; then
      lsof -ti :"$OPENCODE_PORT" | xargs kill 2>/dev/null || true
      echo "  Sent SIGTERM to process(es) on :$OPENCODE_PORT"
    else
      echo "  Nothing listening on :$OPENCODE_PORT"
    fi
  else
    echo "  Install lsof to kill by port, or stop the server tab with Ctrl+C."
  fi
  echo "Done."
  exit 0
fi

# --- IDE-only tab (no dev server in this script)
if [ "$MODE" = "ide-only" ]; then
  echo "Checking OpenCode server on port $OPENCODE_PORT..."
  if ! curl_global_health_ok; then
    echo "ERROR: No healthy server at http://127.0.0.1:$OPENCODE_PORT/global/health" >&2
    echo "Start the dev server in another tab first: $0 (without --ide-only)" >&2
    echo "Use the same --port as the server tab." >&2
    exit 1
  fi
  echo "  Server OK."
  echo ""

  if [ "$FORCE" = false ] && command -v lsof &> /dev/null; then
    if lsof -c "$VSCODE_APP" &> /dev/null; then
      echo "⚠️  WARNING: $VSCODE_APP is already running!"
      echo ""
      echo "  Please close $VSCODE_APP before running this script."
      echo "  Running both instances may cause port conflicts or extension issues."
      echo ""
      echo "  If you want to proceed anyway, run:"
      echo "    $0 --force"
      echo ""
      exit 1
    fi
  fi

  echo "Launching $VSCODE_APP with openchamber extension..."
  echo ""
  echo "  OpenChamber VS Code: set User setting openchamber.apiUrl = http://127.0.0.1:$OPENCODE_PORT"
  echo "  (Otherwise the extension spawns its own opencode serve on a random port; OPENCODE_SKIP_START is not used here.)"
  echo ""

  unset OPENCODE_SERVER_PASSWORD 2>/dev/null || true
  export OPENCODE_PORT

  if command -v "$VSCODE_APP" &> /dev/null; then
    "$VSCODE_APP" "$VSCODE_DIR"
    echo "  $VSCODE_APP started (this tab follows the process; Ctrl+C may close it)."
  elif [ "$VSCODE_APP" = "code" ] && command -v open &> /dev/null; then
    open -a "Visual Studio Code" "$VSCODE_DIR"
    echo "  VSCode launched (open command)"
  elif [ "$VSCODE_APP" = "codium" ] && [ "$(uname -s)" = "Darwin" ]; then
    if ! launch_vscodium_macos_with_env "$VSCODE_DIR"; then
      echo "  WARNING: Could not open VSCodium (tried bundle binary, VSCODIUM_APP, open -a)." >&2
      echo "  Set VSCODIUM_APP, VSCODIUM_APP_NAME, or install the \`codium\` CLI." >&2
    fi
  else
    echo "  WARNING: Could not find \`$VSCODE_APP\` on PATH." >&2
  fi

  echo ""
  echo "Done."
  exit 0
fi

# --- Server logs tab (tail dev.log)
if [ "$SERVER_LOGS" = true ]; then
  LOG_DIR="$HOME/.local/share/opencode/log"
  DEV_LOG="$LOG_DIR/dev.log"

  if [ ! -f "$DEV_LOG" ]; then
    echo "ERROR: Dev log not found at $DEV_LOG"
    echo "Is the dev server running? Start it with: $0"
    exit 1
  fi

  echo "Tailing dev server logs: $DEV_LOG"
  echo "Press Ctrl+C to stop."
  echo ""
  tail -f "$DEV_LOG"
  exit 0
fi

# --- Tool logs tab (tail tools.log)
if [ "$TOOL_LOGS" = true ]; then
  LOG_DIR="$HOME/.local/share/opencode/log"
  TOOLS_LOG="$LOG_DIR/tools.log"

  if [ ! -f "$TOOLS_LOG" ]; then
    echo "ERROR: Tools log not found at $TOOLS_LOG"
    echo "Is the dev server running? Start it with: $0"
    exit 1
  fi

  echo "Tailing tool execution logs: $TOOLS_LOG"
  echo "Press Ctrl+C to stop."
  echo ""
  tail -f "$TOOLS_LOG"
  exit 0
fi

# --- Dev server tab (foreground bun)
if [ ! -d "$BETTER_OPENCODE_DIR" ]; then
  echo "ERROR: better-opencode directory not found: $BETTER_OPENCODE_DIR"
  echo "Set BETTER_OPENCODE_DIR or create a symlink"
  exit 1
fi

if command -v lsof &> /dev/null; then
  if lsof -nP -iTCP:"$OPENCODE_PORT" -sTCP:LISTEN &> /dev/null; then
    echo "ERROR: port $OPENCODE_PORT is already in use."
    echo "Stop it: $0 --stop   or use --port <other>"
    exit 1
  fi
fi

SCRIPT_HINT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
echo "better-opencode dev server (foreground) — leave this tab open; Ctrl+C stops."
echo "Other tab: \"$SCRIPT_HINT\" --ide-only"
echo "Log monitoring: \"$SCRIPT_HINT\" --server-logs | --tool-logs"
echo ""
echo "  OpenChamber (VS Code / VSCodium): set User setting —"
echo "    \"openchamber.apiUrl\": \"http://127.0.0.1:$OPENCODE_PORT\""
echo "  Without this, the extension starts its own opencode serve (random port). OPENCODE_SKIP_START does not apply to the extension."
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
  echo "  NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS (internal HTTPS / Caddy)"
fi
echo ""

cd "$BETTER_OPENCODE_DIR"

# Build server arguments
SERVER_ARGS=(
  --hostname 127.0.0.1
  --port "$OPENCODE_PORT"
  --log-level DEBUG
)

export OPENCODE_DEV=1
export OPENCODE_DISABLE_CHANNEL_DB=1
export OPENCODE_LOG_TOOLS=1

exec env -u OPENCODE_SERVER_PASSWORD OPENCODE_PORT="$OPENCODE_PORT" \
  bun run --cwd packages/opencode --conditions=browser src/index.ts \
  "${SERVER_ARGS[@]}"

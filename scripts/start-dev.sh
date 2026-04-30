#!/bin/bash
# start-dev.sh — Start better-opencode dev server + openchamber VSCode extension
#
# Usage:
#   ./start-dev.sh                    # Start with default settings
#   ./start-dev.sh --stop             # Stop better-opencode server
#   ./start-dev.sh --port 5000        # Use custom port
#   ./start-dev.sh --password secret  # Use custom password
#
# This script:
#   1. Starts better-opencode dev server in the background
#   2. Launches VSCode with environment variables for openchamber extension
#   3. Manages the dev server lifecycle (start/stop)
#
# Requirements:
#   - better-opencode at ~/www/misc/better-opencode
#   - openchamber VSCode extension installed
#   - bun installed
#   - IDE (VSCode/VSCodeVodium) must be CLOSED before running this script

set -euo pipefail

# Configuration
BETTER_OPENCODE_DIR="${BETTER_OPENCODE_DIR:-$HOME/www/misc/better-opencode}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"
OPENCODE_PASSWORD="${OPENCODE_PASSWORD:-opencode_dev}"
VSCODE_DIR="${VSCODE_DIR:-.}"

# VSCode variant - defaults to VSCodeVodium, can be overridden with --vscode or VSCODE_APP env var
VSCODE_APP="${VSCODE_APP:-codium}"  # Default to VSCodeVodium

# Parse arguments
STOP=false
FORCE=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --stop|-s)
      STOP=true
      shift
      ;;
    --port)
      OPENCODE_PORT="$2"
      shift 2
      ;;
    --password)
      OPENCODE_PASSWORD="$2"
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
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --stop, -s    Stop the better-opencode dev server"
      echo "  --port NUM    Port for dev server (default: 4096)"
      echo "  --password TXT Password for dev server auth (default: opencode_dev)"
      echo "  --vscode      Use VSCode instead of VSCodeVodium (default: VSCodeVodium)"
      echo "  --force       Force launch even if $VSCODE_APP is detected as running"
      echo "  --help, -h    Show this help message"
      echo ""
      echo "Environment variables:"
      echo "  BETTER_OPENCODE_DIR  Path to better-opencode (default: ~/www/misc/better-opencode)"
      echo "  OPENCODE_PORT        Port for dev server (default: 4096)"
      echo "  OPENCODE_PASSWORD    Password for dev server (default: opencode_dev)"
      echo "  VSCODE_APP           VSCode variant: 'codium' (VSCodeVodium) or 'code' (VSCode)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# PID file for managing the dev server
PID_FILE="$HOME/.local/share/better-opencode-dev.pid"
LOG_FILE="$HOME/.local/share/better-opencode-dev.log"

# Ensure directories exist
mkdir -p "$HOME/.local/share"

if [ "$STOP" = true ]; then
  echo "Stopping better-opencode dev server..."
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      echo "  Stopped process $PID"
    else
      echo "  Process $PID not running"
    fi
    rm -f "$PID_FILE"
  else
    echo "  No PID file found"
  fi
  
  # Also kill any processes on the port
  if command -v lsof &> /dev/null; then
    lsof -ti :"$OPENCODE_PORT" | xargs kill 2>/dev/null || true
  fi
  
  echo "Done."
  exit 0
fi

# Validate better-opencode directory
if [ ! -d "$BETTER_OPENCODE_DIR" ]; then
  echo "ERROR: better-opencode directory not found: $BETTER_OPENCODE_DIR"
  echo "Set BETTER_OPENCODE_DIR environment variable or create a symlink"
  exit 1
fi

# Check if dev server is already running
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "better-opencode dev server is already running (PID: $PID) on port $OPENCODE_PORT"
    echo "Use --stop to stop it first, or connect to it"
    echo ""
    echo "To connect openchamber to this server, set:"
    echo "  OPENCODE_PORT=$OPENCODE_PORT"
    echo "  OPENCODE_SKIP_START=true"
    echo "  OPENCODE_SERVER_PASSWORD=$OPENCODE_PASSWORD"
    exit 0
  else
    echo "Cleaning up stale PID file..."
    rm -f "$PID_FILE"
  fi
fi

# Start better-opencode dev server
echo "Starting better-opencode dev server..."
echo "  Directory: $BETTER_OPENCODE_DIR"
echo "  Port: $OPENCODE_PORT"
echo "  Log: $LOG_FILE"
echo ""

cd "$BETTER_OPENCODE_DIR"

# Start the dev server in the background
OPENCODE_PORT="$OPENCODE_PORT" \
OPENCODE_SERVER_PASSWORD="$OPENCODE_PASSWORD" \
bun run --cwd packages/opencode --conditions=browser src/index.ts \
  --hostname 127.0.0.1 \
  --port "$OPENCODE_PORT" \
  > "$LOG_FILE" 2>&1 &

PID=$!
echo "$PID" > "$PID_FILE"

echo "  PID: $PID"
echo ""

# Wait for server to start
echo "Waiting for server to start..."
for i in {1..10}; do
  if curl -s http://127.0.0.1:"$OPENCODE_PORT"/global/health > /dev/null 2>&1; then
    echo "  Server is ready!"
    break
  fi
  sleep 0.5
done

# Verify server is running
if ! curl -s http://127.0.0.1:"$OPENCODE_PORT"/global/health | grep -q '"healthy"'; then
  echo "ERROR: Server failed to start. Check log: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  better-opencode dev server started!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Server: http://127.0.0.1:$OPENCODE_PORT"
echo "  Health: $(curl -s http://127.0.0.1:$OPENCODE_PORT/global/health)"
echo ""
echo "  To stop: $0 --stop"
echo ""
echo "  Openchamber configuration:"
echo "    OPENCODE_PORT=$OPENCODE_PORT"
echo "    OPENCODE_SKIP_START=true"
echo "    OPENCODE_SERVER_PASSWORD=$OPENCODE_PASSWORD"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""

# Check if VSCode/VSCodeVodium is already running
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

# Launch VSCode with environment variables for openchamber
echo "Launching $VSCODE_APP with openchamber extension..."
echo ""

# Set environment variables for VSCode
export OPENCODE_PORT
export OPENCODE_SKIP_START=true
export OPENCODE_SERVER_PASSWORD

# Launch VSCode variant (try command, fallback to open)
if command -v "$VSCODE_APP" &> /dev/null; then
  "$VSCODE_APP" "$VSCODE_DIR" &
  echo "  $VSCODE_APP launched ($VSCODE_APP command)"
elif [ "$VSCODE_APP" = "code" ] && command -v open &> /dev/null; then
  open -a "Visual Studio Code" "$VSCODE_DIR" &
  echo "  VSCode launched (open command)"
elif [ "$VSCODE_APP" = "codium" ] && command -v open &> /dev/null; then
  open -a "VSCodeVodium" "$VSCODE_DIR" &
  echo "  VSCodeVodium launched (open command)"
else
  echo "  WARNING: Could not find $VSCODE_APP command"
  echo "  Please open $VSCODE_APP manually with these environment variables:"
  echo "    OPENCODE_PORT=$OPENCODE_PORT"
  echo "    OPENCODE_SKIP_START=true"
  echo "    OPENCODE_SERVER_PASSWORD=$OPENCODE_PASSWORD"
fi

echo ""
echo "Done. The dev server will continue running in the background."
echo "Press Ctrl+C in this terminal to exit (server keeps running)."
echo ""

# Keep script running so environment variables persist
# (Optional: remove this line if you want the script to exit)
wait $PID 2>/dev/null || true

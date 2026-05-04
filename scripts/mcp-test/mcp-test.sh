#!/bin/bash
# mcp-test.sh — MCP Server Smoke Test
# Tests MCP servers using live connections via direct JSON-RPC.
# Reads server definitions directly from opencode config.
#
# Protocol:
#   Local (stdio):  initialize → tools/list → tools/call (on shouldTest tool)
#   Remote (HTTP):  tools/list → tools/call (on shouldTest tool) via JSON-RPC over HTTP+SSE
#
# Usage:
#   mcp-test.sh [OPTIONS]
#
# Options:
#   --all              Test all servers including disabled ones
#   --server <name>    Test only the specified server (can be repeated)
#   --category <cat>   Test only servers in the specified category
#   --json             Output in JSON format
#   --no-color         Disable colored output
#   --config <path>    Path to opencode config (default: $HOME/.config/opencode/opencode.json)
#   --quiet            Suppress verbose output, show only summary
#   --help             Show help message
#   --version          Show version
#
# Exit Codes:
#   0  All servers passed
#   1  One or more servers failed
#   2  Configuration error (missing config, no servers found)

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────
SCRIPT_VERSION="4.0.0"
CONFIG_PATH="${OPENCODE_CONFIG:-$HOME/.config/opencode/opencode.json}"

# ──────────────────────────────────────────────────────────────────────────────
# Color support
# ──────────────────────────────────────────────────────────────────────────────
if [[ "${NO_COLOR:-0}" == "1" ]] || [[ "${NO_COLOR:-0}" == "true" ]] || [[ "${FORCE_COLOR:-}" == "false" ]]; then
    COLOR_OFF=""
    COLOR_GREEN=""
    COLOR_RED=""
    COLOR_YELLOW=""
    COLOR_BOLD=""
else
    COLOR_OFF="\033[0m"
    COLOR_GREEN="\033[0;32m"
    COLOR_RED="\033[0;31m"
    COLOR_YELLOW="\033[0;33m"
    COLOR_BOLD="\033[1m"
fi

# ──────────────────────────────────────────────────────────────────────────────
# CLI Flags
# ──────────────────────────────────────────────────────────────────────────────
ALL_SERVERS=false
SERVER_FILTER=()
CATEGORY_FILTER=""
OUTPUT_FORMAT="human"
QUIET=false

# ──────────────────────────────────────────────────────────────────────────────
# Usage
# ──────────────────────────────────────────────────────────────────────────────
usage() {
    cat <<'EOF'
MCP Smoke Test — Validate MCP server health using live JSON-RPC connections

Usage:
  mcp-test.sh [OPTIONS]

Options:
  --all              Test all servers including disabled ones
  --server <name>    Test only the specified server (can be repeated)
  --category <cat>   Test only servers in the specified category
  --json             Output in JSON format (also enables --no-color)
  --config <path>    Path to opencode config (default: $HOME/.config/opencode/opencode.json)
  --quiet            Suppress verbose output, show only summary
  --no-color         Disable colored output
  --help             Show help message
  --version          Show version

Examples:
  mcp-test.sh                        # Test all enabled servers
  mcp-test.sh --server github        # Test only GitHub server
  mcp-test.sh --category database    # Test only database servers
  mcp-test.sh --all --json           # All servers (incl. disabled), JSON output

Exit Codes:
  0  All servers passed
  1  One or more servers failed
  2  Configuration error (missing config, no servers found)
EOF
}

# ──────────────────────────────────────────────────────────────────────────────
# Argument Parsing
# ──────────────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            usage
            exit 0
            ;;
        --version|-v)
            echo "mcp-test.sh version ${SCRIPT_VERSION}"
            exit 0
            ;;
        --all)
            ALL_SERVERS=true
            shift
            ;;
        --server)
            SERVER_FILTER+=("$2")
            shift 2
            ;;
        --category)
            CATEGORY_FILTER="$2"
            shift 2
            ;;
        --json)
            OUTPUT_FORMAT="json"
            NO_COLOR="1"
            shift
            ;;
        --config)
            CONFIG_PATH="$2"
            shift 2
            ;;
        --quiet)
            QUIET=true
            shift
            ;;
        --no-color)
            NO_COLOR="1"
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

# ──────────────────────────────────────────────────────────────────────────────
# Config Validation
# ──────────────────────────────────────────────────────────────────────────────
if [[ ! -f "$CONFIG_PATH" ]]; then
    echo "Error: Config file not found at ${CONFIG_PATH}" >&2
    exit 2
fi

# ──────────────────────────────────────────────────────────────────────────────
# Delegate to Python engine
# ──────────────────────────────────────────────────────────────────────────────
export CONFIG_PATH
export ALL_SERVERS
export CATEGORY_FILTER
export OUTPUT_FORMAT
export QUIET
export NO_COLOR
export FIXTURES_DIR="$(dirname "$0")/fixtures"

if [[ ${#SERVER_FILTER[@]} -gt 0 ]]; then
    _SF="$(IFS=','; echo "${SERVER_FILTER[*]}")"
    export _SF
else
    export _SF=""
fi

python3 << 'PYEOF'
import json
import subprocess
import os
import time
import sys
import select
import urllib.request
import urllib.error

CONFIG_PATH = os.environ.get("CONFIG_PATH", "")
ALL_SERVERS = os.environ.get("ALL_SERVERS", "false").lower() == "true"
CATEGORY_FILTER = os.environ.get("CATEGORY_FILTER", "")
OUTPUT_FORMAT = os.environ.get("OUTPUT_FORMAT", "human")
QUIET = os.environ.get("QUIET", "false").lower() == "true"
NO_COLOR = os.environ.get("NO_COLOR", "0") == "1"
FIXTURES_DIR = os.environ.get("FIXTURES_DIR", "")

DEFAULT_TIMEOUT_LOCAL = 60
DEFAULT_TIMEOUT_REMOTE = 60
CHROME_DEBUG_PORT = 9222
CHROME_DEBUG_PROFILE = os.path.expanduser("~/chrome-debug-profile")

if NO_COLOR:
    COLOR_OFF = COLOR_GREEN = COLOR_RED = COLOR_YELLOW = COLOR_BOLD = ""
else:
    COLOR_OFF = "\033[0m"
    COLOR_GREEN = "\033[0;32m"
    COLOR_RED = "\033[0;31m"
    COLOR_YELLOW = "\033[0;33m"
    COLOR_BOLD = "\033[1m"

def get_color(status):
    if status == "passed":
        return COLOR_GREEN
    elif status == "failed":
        return COLOR_RED
    return COLOR_YELLOW

# ──────────────────────────────────────────────────────────────────────────────
# Config Parsing
# ──────────────────────────────────────────────────────────────────────────────
def parse_servers():
    """Parse MCP servers from opencode config."""
    with open(CONFIG_PATH, "r") as f:
        config = json.load(f)
    mcp = config.get("mcp", {})
    results = []
    server_filter = os.environ.get("_SF", "")

    for name, srv in mcp.items():
        # Skip disabled servers unless --all
        if not ALL_SERVERS and not srv.get("enabled", True):
            continue

        # Filter by server name
        if server_filter and name not in server_filter.split(","):
            continue

        # Filter by category
        if CATEGORY_FILTER and srv.get("category", "") != CATEGORY_FILTER:
            continue

        results.append({
            "name": name,
            "type": srv.get("type", "local"),
            "command": srv.get("command", []),
            "url": srv.get("url"),
            "headers": srv.get("headers", {}),
            "environment": srv.get("environment", {}),
            "category": srv.get("category", "general"),
            "enabled": True
        })
    return results

# ──────────────────────────────────────────────────────────────────────────────
# Fixture Loader
# ──────────────────────────────────────────────────────────────────────────────
def load_fixture(server_name):
    """Load a fixture file for a server if it exists.

    Returns the fixture dict or None if not found.
    The fixture contains the tools_list_response with shouldTest markers.
    """
    if not FIXTURES_DIR:
        return None

    fixture_path = os.path.join(FIXTURES_DIR, f"{server_name}.json")
    if not os.path.isfile(fixture_path):
        return None

    try:
        with open(fixture_path, "r") as f:
            return json.load(f)
    except Exception:
        return None

def get_should_test_tool(server_name, live_tools):
    """Get the shouldTest tool and its queryPayload for a server.

    Returns (tool_dict, queryPayload_or_None).
    The tool dict comes from the live response (with live inputSchema),
    but the tool is selected based on the fixture's shouldTest marker.
    The queryPayload comes from the fixture — if defined, it overrides
    the auto-generated args from build_default_args.

    Priority:
    1. Fixture's shouldTest tool name → look up in live tools
    2. Live tools/list response's shouldTest tool (unlikely, servers don't include it)
    3. First available tool from live response
    """
    # Try fixture first — get the tool name + queryPayload from fixture
    fixture = load_fixture(server_name)
    if fixture:
        tools_from_fixture = fixture.get("tools_list_response", {}).get("tools", [])
        for tool in tools_from_fixture:
            if tool.get("shouldTest"):
                fixture_tool_name = tool["name"]
                query_payload = tool.get("queryPayload")
                # Look up this tool in the live response to get the live inputSchema
                for live_tool in live_tools:
                    if live_tool["name"] == fixture_tool_name:
                        return (live_tool, query_payload)
                # If not found in live (schema changed), use fixture tool as fallback
                return (tool, query_payload)

    # Fall back to live tools
    if live_tools:
        return (live_tools[0], None)

    return (None, None)

# ──────────────────────────────────────────────────────────────────────────────
# Default Argument Builder

# ──────────────────────────────────────────────────────────────────────────────
# Default Argument Builder
# ──────────────────────────────────────────────────────────────────────────────
def _default_value_for_prop(prop_name, prop_def):
    """Generate a sensible default value for a schema property."""
    if "default" in prop_def:
        return prop_def["default"]

    prop_type = prop_def.get("type", "string")

    if prop_type == "string":
        if "enum" in prop_def:
            return prop_def["enum"][0]
        # Context-aware defaults for common property names
        defaults = {
            "markdown": "# Test\n\nThis is a test markdown document.",
            "diagram": "graph TD; A-->B;",
            "query": "test",
            "library": "express",
            "libraryName": "express",
            "libraryId": "1",
            "name": "test-name",
            "path": "README.md",
            "owner": "test-owner",
            "repo": "test-repo",
            "pullNumber": 1,
            "issue_number": 1,
            "commentId": 1,
            "sha": "HEAD",
            "id": "1",
            "format": "svg",
        }
        if prop_name in defaults:
            return defaults[prop_name]
        return f"test_{prop_name}"
    elif prop_type == "integer" or prop_type == "number":
        return 1
    elif prop_type == "boolean":
        return True
    elif prop_type == "array":
        return []
    elif prop_type == "object":
        return {}
    else:
        return f"test_{prop_name}"

def build_default_args(input_schema):
    """Build default arguments from a tool's inputSchema.

    For each required property, generate a minimal test value based on type.
    For optional properties with defaults, use the default.
    If no 'required' field is present (some servers omit it), include all
    properties that have sensible defaults.
    """
    args = {}
    properties = input_schema.get("properties", {})
    required = input_schema.get("required", [])

    # Fill required properties first
    for prop_name in required:
        prop_def = properties.get(prop_name, {})
        args[prop_name] = _default_value_for_prop(prop_name, prop_def)

    # Also include optional properties with defaults
    for prop_name, prop_def in properties.items():
        if prop_name not in args and "default" in prop_def:
            args[prop_name] = prop_def["default"]

    # If no required field was specified (some servers omit it), include
    # the first string property as a fallback — most tools need at least one arg
    if not required and not args and properties:
        for prop_name, prop_def in properties.items():
            if prop_def.get("type") == "string":
                args[prop_name] = _default_value_for_prop(prop_name, prop_def)
                break

    return args

# ──────────────────────────────────────────────────────────────────────────────
# Remote Server Testing (HTTP JSON-RPC with SSE)
# ──────────────────────────────────────────────────────────────────────────────
def _remote_jsonrpc(url, method, params, headers, timeout):
    """Send a JSON-RPC request to a remote MCP server and parse SSE response."""
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()

    req_headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    req_headers.update(headers)

    req = urllib.request.Request(url, data=payload, headers=req_headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise RuntimeError(f"HTTP {e.code}: {body[:200]}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Connection error: {e.reason}")

    # Parse SSE: extract data lines
    responses = []
    for line in raw.split("\n"):
        line = line.strip()
        if line.startswith("data: "):
            data_str = line[6:]  # strip "data: " prefix
            try:
                data = json.loads(data_str)
                responses.append(data)
            except json.JSONDecodeError:
                continue
        elif line.startswith("data:"):
            data_str = line[5:]
            try:
                data = json.loads(data_str)
                responses.append(data)
            except json.JSONDecodeError:
                continue

    if not responses:
        raise RuntimeError(f"No SSE data received. Raw response: {raw[:500]}")

    # Return the last response (some servers send multiple events)
    return responses[-1]

def test_remote_server(server):
    """Test a remote (HTTP) MCP server using direct JSON-RPC."""
    name = server["name"]
    url = server["url"]
    headers = server.get("headers", {})
    environment = server.get("environment", {})
    timeout = DEFAULT_TIMEOUT_REMOTE
    start_time = time.time()

    checks = []
    overall_status = "passed"

    # ── Check 1: Server startup (ping via JSON-RPC) ──
    check_start = time.time()
    try:
        # Use a JSON-RPC ping to verify connectivity (HEAD doesn't work on MCP endpoints)
        response = _remote_jsonrpc(url, "ping", {}, headers, 5)
        # Any response (even an error) means the server is reachable
        checks.append({"name": "server-startup", "status": "passed",
                        "duration_ms": int((time.time() - check_start) * 1000)})
    except Exception as e:
        checks.append({"name": "server-startup", "status": "failed",
                        "duration_ms": int((time.time() - check_start) * 1000),
                        "error": str(e)})
        overall_status = "failed"
        return {
            "name": name, "type": "remote", "category": server.get("category", "general"),
            "status": overall_status, "checks": checks,
            "total_duration_ms": int((time.time() - start_time) * 1000),
            "failed_checks": [c["name"] for c in checks if c["status"] == "failed"]
        }

    # ── Check 2: Tools list via JSON-RPC ──
    check_tools = time.time()
    tools_data = None
    try:
        response = _remote_jsonrpc(url, "tools/list", {}, headers, timeout)
        if "result" in response:
            tools_data = response["result"]
            tool_count = len(tools_data.get("tools", []))
            checks.append({"name": "tools-list", "status": "passed",
                            "duration_ms": int((time.time() - check_tools) * 1000),
                            "tool_count": tool_count})
        elif "error" in response:
            err = response["error"]
            checks.append({"name": "tools-list", "status": "failed",
                            "duration_ms": int((time.time() - check_tools) * 1000),
                            "error": f"JSON-RPC error: {err.get('message', str(err))}"})
            overall_status = "failed"
        else:
            checks.append({"name": "tools-list", "status": "failed",
                            "duration_ms": int((time.time() - check_tools) * 1000),
                            "error": f"Unexpected response: {json.dumps(response)[:200]}"})
            overall_status = "failed"
    except Exception as e:
        checks.append({"name": "tools-list", "status": "failed",
                        "duration_ms": int((time.time() - check_tools) * 1000),
                        "error": str(e)})
        overall_status = "failed"

    # ── Check 3: Response validity ──
    if tools_data is not None:
        checks.append({"name": "response-validity", "status": "passed", "duration_ms": 0})
    elif overall_status == "passed":
        checks.append({"name": "response-validity", "status": "failed", "duration_ms": 0,
                        "error": "No valid tools-list response"})
        overall_status = "failed"

    # ── Check 4: Tool invocation (tools/call) ──
    if tools_data is not None:
        should_test_tool, query_payload = get_should_test_tool(name, tools_data.get("tools", []))

        if should_test_tool:
            check_call = time.time()
            tool_name = should_test_tool["name"]
            # Use fixture queryPayload if defined, otherwise auto-generate from schema
            if query_payload is not None:
                args = query_payload
            else:
                input_schema = should_test_tool.get("inputSchema", {})
                args = build_default_args(input_schema)

            try:
                response = _remote_jsonrpc(url, "tools/call",
                                            {"name": tool_name, "arguments": args},
                                            headers, timeout)
                if "result" in response:
                    result = response["result"]
                    content = result.get("content", [])
                    content_preview = ""
                    if content:
                        text_parts = [c.get("text", "") for c in content if c.get("type") == "text"]
                        content_preview = " ".join(text_parts)[:500]
                    checks.append({"name": "tools-call", "status": "passed",
                                    "duration_ms": int((time.time() - check_call) * 1000),
                                    "tool": tool_name,
                                    "content_preview": content_preview})
                elif "error" in response:
                    err = response["error"]
                    checks.append({"name": "tools-call", "status": "failed",
                                    "duration_ms": int((time.time() - check_call) * 1000),
                                    "tool": tool_name,
                                    "error": f"JSON-RPC error: {err.get('message', str(err))}"})
                    overall_status = "failed"
                else:
                    checks.append({"name": "tools-call", "status": "failed",
                                    "duration_ms": int((time.time() - check_call) * 1000),
                                    "tool": tool_name,
                                    "error": f"Unexpected response: {json.dumps(response)[:200]}"})
                    overall_status = "failed"
            except Exception as e:
                checks.append({"name": "tools-call", "status": "failed",
                                "duration_ms": int((time.time() - check_call) * 1000),
                                "tool": tool_name,
                                "error": str(e)})
                overall_status = "failed"
        else:
            checks.append({"name": "tools-call", "status": "skipped",
                            "duration_ms": 0,
                            "error": "No tools available to test"})

    total_duration = int((time.time() - start_time) * 1000)
    failed_checks = [c["name"] for c in checks if c["status"] == "failed"]

    return {
        "name": name, "type": "remote", "category": server.get("category", "general"),
        "status": overall_status, "checks": checks,
        "total_duration_ms": total_duration, "failed_checks": failed_checks
    }

# ──────────────────────────────────────────────────────────────────────────────
# Local Server Testing (stdio JSON-RPC)
# ──────────────────────────────────────────────────────────────────────────────
def _stdio_send(proc, message):
    """Send a JSON-RPC message to a stdio server process."""
    msg = json.dumps(message) + "\n"
    proc.stdin.write(msg)
    proc.stdin.flush()

def _stdio_read_line(proc, timeout=10):
    """Read a single line from the server's stdout with timeout."""
    deadline = time.time() + timeout
    buf = []
    while time.time() < deadline:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        ready, _, _ = select.select([proc.stdout], [], [], remaining)
        if ready:
            chunk = proc.stdout.readline()
            if not chunk:
                break  # EOF
            buf.append(chunk)
            if chunk.endswith("\n"):
                return "".join(buf)
    return "".join(buf) if buf else None

def _stdio_jsonrpc_call(proc, method, params, timeout=10):
    """Send a JSON-RPC call to a stdio server and wait for the response.

    Skips notifications (messages without 'id' field) that may be sent
    before the actual response.
    """
    _stdio_send(proc, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})

    # Read response, skipping any notifications
    deadline = time.time() + timeout
    while time.time() < deadline:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        line = _stdio_read_line(proc, remaining)
        if line is None:
            raise RuntimeError(f"No response from server for {method}")

        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            raise RuntimeError(f"Invalid JSON response from server: {line[:200]}")

        # Skip notifications (no 'id' field) — they're not responses
        if "id" not in parsed:
            continue

        return parsed

    raise RuntimeError(f"No response from server for {method}")

# ──────────────────────────────────────────────────────────────────────────────
# Chrome Debug Helper
# ──────────────────────────────────────────────────────────────────────────────
_chrome_debug_proc = None

def _is_port_open(port, host="127.0.0.1", timeout=3):
    """Check if a TCP port is open and accepting connections."""
    import socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((host, port))
        sock.close()
        return result == 0
    except Exception:
        return False

def _ensure_chrome_debug():
    """Spawn Chrome with remote debugging if not already running.

    Returns True if Chrome debug port is available, False otherwise.
    """
    global _chrome_debug_proc

    # Already running?
    if _is_port_open(CHROME_DEBUG_PORT):
        return True

    # Chrome already spawned by us?
    if _chrome_debug_proc is not None and _chrome_debug_proc.poll() is None:
        # Give it a few more seconds
        for _ in range(5):
            if _is_port_open(CHROME_DEBUG_PORT):
                return True
            time.sleep(1)
        return False

    # Try to find Chrome
    chrome_paths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    chrome_path = None
    for p in chrome_paths:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            chrome_path = p
            break

    if chrome_path is None:
        return False

    # Spawn Chrome with debug flags
    cmd = [
        chrome_path,
        "--remote-debugging-port=" + str(CHROME_DEBUG_PORT),
        "--disable-web-security",
        "--user-data-dir=" + CHROME_DEBUG_PROFILE,
        "--no-first-run",
        "--no-default-browser-check",
    ]
    try:
        _chrome_debug_proc = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True
        )
        # Wait for port to open (up to 10 seconds)
        for _ in range(10):
            time.sleep(1)
            if _is_port_open(CHROME_DEBUG_PORT):
                return True
    except Exception:
        pass

    return False

def test_local_server(server):
    """Test a local (stdio) MCP server using direct JSON-RPC."""
    name = server["name"]
    command = server.get("command", [])
    environment = server.get("environment", {})
    timeout = DEFAULT_TIMEOUT_LOCAL
    start_time = time.time()

    checks = []
    overall_status = "passed"
    proc = None
    chrome_spawned = False

    # ── Pre-check: Chrome debug for chrome-devtools server ──
    if name == "chrome-devtools":
        if not _ensure_chrome_debug():
            checks.append({"name": "server-startup", "status": "failed",
                            "duration_ms": 0,
                            "error": "Chrome not found or debug port 9222 unavailable"})
            return {
                "name": name, "type": "local", "category": server.get("category", "general"),
                "status": "failed", "checks": checks,
                "total_duration_ms": 0,
                "failed_checks": ["server-startup"]
            }
        chrome_spawned = True

    # ── Check 1: Server startup ──
    check_start = time.time()
    try:
        full_env = {**os.environ}
        for k, v in environment.items():
            full_env[k] = v

        proc = subprocess.Popen(
            command, env=full_env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, cwd="/tmp"
        )
        # Wait a moment for the server to start
        time.sleep(0.5)

        # Check if the process is still alive
        if proc.poll() is not None:
            stderr = proc.stderr.read() if proc.stderr else ""
            raise RuntimeError(f"Server exited immediately: {stderr.strip()[:200]}")

        checks.append({"name": "server-startup", "status": "passed",
                        "duration_ms": int((time.time() - check_start) * 1000)})
    except FileNotFoundError as e:
        checks.append({"name": "server-startup", "status": "failed",
                        "duration_ms": int((time.time() - check_start) * 1000),
                        "error": f"Command not found: {e}"})
        overall_status = "failed"
    except Exception as e:
        checks.append({"name": "server-startup", "status": "failed",
                        "duration_ms": int((time.time() - check_start) * 1000),
                        "error": str(e)})
        overall_status = "failed"

    if overall_status == "failed":
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        return {
            "name": name, "type": "local", "category": server.get("category", "general"),
            "status": overall_status, "checks": checks,
            "total_duration_ms": int((time.time() - start_time) * 1000),
            "failed_checks": [c["name"] for c in checks if c["status"] == "failed"]
        }

    # ── Check 2: Initialize ──
    check_init = time.time()
    init_response = None
    try:
        init_response = _stdio_jsonrpc_call(proc, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "mcp-test", "version": "4.0.0"}
        }, timeout=10)

        if "result" in init_response:
            checks.append({"name": "protocol-init", "status": "passed",
                            "duration_ms": int((time.time() - check_init) * 1000)})
        elif "error" in init_response:
            err = init_response["error"]
            checks.append({"name": "protocol-init", "status": "failed",
                            "duration_ms": int((time.time() - check_init) * 1000),
                            "error": f"Init error: {err.get('message', str(err))}"})
            overall_status = "failed"
        else:
            checks.append({"name": "protocol-init", "status": "failed",
                            "duration_ms": int((time.time() - check_init) * 1000),
                            "error": f"Unexpected init response: {json.dumps(init_response)[:200]}"})
            overall_status = "failed"
    except Exception as e:
        checks.append({"name": "protocol-init", "status": "failed",
                        "duration_ms": int((time.time() - check_init) * 1000),
                        "error": str(e)})
        overall_status = "failed"

    # Send initialized notification (required before tools/list)
    if init_response and "result" in init_response:
        try:
            _stdio_send(proc, {
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            })
        except Exception:
            pass  # Notification, no response expected

    # ── Check 3: Tools list ──
    check_tools = time.time()
    tools_data = None
    if init_response and "result" in init_response:
        try:
            tools_response = _stdio_jsonrpc_call(proc, "tools/list", {}, timeout=10)
            if "result" in tools_response:
                tools_data = tools_response["result"]
                tool_count = len(tools_data.get("tools", []))
                checks.append({"name": "tools-list", "status": "passed",
                                "duration_ms": int((time.time() - check_tools) * 1000),
                                "tool_count": tool_count})
            elif "error" in tools_response:
                err = tools_response["error"]
                checks.append({"name": "tools-list", "status": "failed",
                                "duration_ms": int((time.time() - check_tools) * 1000),
                                "error": f"Tools error: {err.get('message', str(err))}"})
                overall_status = "failed"
            else:
                checks.append({"name": "tools-list", "status": "failed",
                                "duration_ms": int((time.time() - check_tools) * 1000),
                                "error": f"Unexpected tools response: {json.dumps(tools_response)[:200]}"})
                overall_status = "failed"
        except Exception as e:
            checks.append({"name": "tools-list", "status": "failed",
                            "duration_ms": int((time.time() - check_tools) * 1000),
                            "error": str(e)})
            overall_status = "failed"
    else:
        checks.append({"name": "tools-list", "status": "skipped",
                        "duration_ms": 0,
                        "error": "Skipped: server did not initialize"})
        checks.append({"name": "response-validity", "status": "skipped",
                        "duration_ms": 0,
                        "error": "Skipped: server did not initialize"})
        checks.append({"name": "tools-call", "status": "skipped",
                        "duration_ms": 0,
                        "error": "Skipped: server did not initialize"})

        # Cleanup
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

        total_duration = int((time.time() - start_time) * 1000)
        failed_checks = [c["name"] for c in checks if c["status"] == "failed"]

        return {
            "name": name, "type": "local", "category": server.get("category", "general"),
            "status": overall_status, "checks": checks,
            "total_duration_ms": total_duration, "failed_checks": failed_checks
        }

    # ── Check 4: Response validity ──
    if tools_data is not None:
        checks.append({"name": "response-validity", "status": "passed", "duration_ms": 0})
    elif overall_status == "passed":
        checks.append({"name": "response-validity", "status": "failed", "duration_ms": 0,
                        "error": "No valid tools-list response"})
        overall_status = "failed"

    # ── Check 5: Tool invocation (tools/call) ──
    if tools_data is not None:
        should_test_tool, query_payload = get_should_test_tool(name, tools_data.get("tools", []))

        if should_test_tool:
            check_call = time.time()
            tool_name = should_test_tool["name"]
            # Use fixture queryPayload if defined, otherwise auto-generate from schema
            if query_payload is not None:
                args = query_payload
            else:
                input_schema = should_test_tool.get("inputSchema", {})
                args = build_default_args(input_schema)

            try:
                call_response = _stdio_jsonrpc_call(proc, "tools/call",
                                                     {"name": tool_name, "arguments": args},
                                                     timeout=120)
                if "result" in call_response:
                    result = call_response["result"]
                    content = result.get("content", [])
                    content_preview = ""
                    if content:
                        text_parts = [c.get("text", "") for c in content if c.get("type") == "text"]
                        content_preview = " ".join(text_parts)[:500]
                    checks.append({"name": "tools-call", "status": "passed",
                                    "duration_ms": int((time.time() - check_call) * 1000),
                                    "tool": tool_name,
                                    "content_preview": content_preview})
                elif "error" in call_response:
                    err = call_response["error"]
                    checks.append({"name": "tools-call", "status": "failed",
                                    "duration_ms": int((time.time() - check_call) * 1000),
                                    "tool": tool_name,
                                    "error": f"Call error: {err.get('message', str(err))}"})
                    overall_status = "failed"
                else:
                    checks.append({"name": "tools-call", "status": "failed",
                                    "duration_ms": int((time.time() - check_call) * 1000),
                                    "tool": tool_name,
                                    "error": f"Unexpected call response: {json.dumps(call_response)[:200]}"})
                    overall_status = "failed"
            except Exception as e:
                checks.append({"name": "tools-call", "status": "failed",
                                "duration_ms": int((time.time() - check_call) * 1000),
                                "tool": tool_name,
                                "error": str(e)})
                overall_status = "failed"
        else:
            checks.append({"name": "tools-call", "status": "skipped",
                            "duration_ms": 0,
                            "error": "No tools available to test"})

    # ── Cleanup ──
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    total_duration = int((time.time() - start_time) * 1000)
    failed_checks = [c["name"] for c in checks if c["status"] == "failed"]

    return {
        "name": name, "type": "local", "category": server.get("category", "general"),
        "status": overall_status, "checks": checks,
        "total_duration_ms": total_duration, "failed_checks": failed_checks
    }

# ──────────────────────────────────────────────────────────────────────────────
# Server Test Dispatcher
# ──────────────────────────────────────────────────────────────────────────────
def run_server_test(server):
    """Route to the appropriate test function based on server type."""
    server_type = server.get("type", "local")
    if server_type == "remote":
        return test_remote_server(server)
    else:
        return test_local_server(server)

# ──────────────────────────────────────────────────────────────────────────────
# Report Generators
# ──────────────────────────────────────────────────────────────────────────────
def generate_human_report(results):
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    total = len(results)
    passed = sum(1 for s in results if s["status"] == "passed")
    failed = sum(1 for s in results if s["status"] == "failed")
    skipped = sum(1 for s in results if any(c.get("status") == "skipped" for c in s["checks"]))

    print(f"\nMCP Smoke Test (LIVE) — {timestamp}")
    print("=" * 60)
    print(f"Servers: {total} total | {passed} passed | {failed} failed | {skipped} skipped")
    print(f"Checks: server-startup, protocol-init, tools-list, response-validity, tools-call")
    print("")

    if not QUIET:
        print(f"{'Server':<25} {'Type':<8} {'Status':<8} {'Duration':<10}")
        print(f"{'-'*25} {'-'*8} {'-'*8} {'-'*10}")
        for s in results:
            status = "PASS" if s["status"] == "passed" else "FAIL"
            dur = s["total_duration_ms"] / 1000
            color = get_color(s["status"])
            print(f"{color}{s['name']:25s} {s['type']:8s} {status:8s} {dur:10.1f}s{COLOR_OFF}")
        print("")

    # Show check details for each server
    if not QUIET:
        for s in results:
            has_issues = any(c["status"] in ("failed", "skipped") for c in s["checks"])
            if has_issues or s["status"] == "passed":
                for c in s["checks"]:
                    status_sym = "✓" if c["status"] == "passed" else ("✗" if c["status"] == "failed" else "—")
                    color = get_color(c["status"])
                    detail = ""
                    if c.get("tool_count"):
                        detail = f" ({c['tool_count']} tools)"
                    if c.get("tool"):
                        detail = f" (tool: {c['tool']})"
                    if c.get("error"):
                        detail = f": {c['error'][:80]}"
                    if c.get("content_preview"):
                        detail = f" (tool: {c['tool']}, preview: {c['content_preview'][:60]}...)"
                    print(f"  {color}{status_sym} {s['name']:24s} {c['name']:20s}{detail}{COLOR_OFF}")
        print("")

    has_failures = any(s["status"] == "failed" for s in results)
    if has_failures:
        print("Failed Servers:")
        print("-" * 80)
        for s in results:
            if s["status"] == "failed":
                print(f"  {s['name']}")
                for c in s["checks"]:
                    if c["status"] == "failed":
                        print(f"    ✗ {c['name']}: {c.get('error', 'unknown')}")
        print("")

    total_duration = sum(s["total_duration_ms"] for s in results)
    print(f"Total duration: {total_duration}ms\n")
    return 1 if failed > 0 else 0

def generate_json_report(results):
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    total = len(results)
    passed = sum(1 for s in results if s["status"] == "passed")
    failed = sum(1 for s in results if s["status"] == "failed")
    total_duration = sum(s["total_duration_ms"] for s in results)

    report = {
        "timestamp": timestamp, "mode": "live",
        "version": "4.0.0",
        "config_path": CONFIG_PATH,
        "summary": {"total": total, "passed": passed, "failed": failed,
                     "duration_ms": total_duration},
        "servers": results
    }
    print(json.dumps(report, indent=2))
    return 1 if failed > 0 else 0

# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────
def main():
    servers = parse_servers()
    if not servers:
        print("Error: No servers found matching filters", file=sys.stderr)
        sys.exit(2)

    results = [run_server_test(s) for s in servers]

    if OUTPUT_FORMAT == "json":
        sys.exit(generate_json_report(results))
    else:
        sys.exit(generate_human_report(results))

if __name__ == "__main__":
    main()
PYEOF

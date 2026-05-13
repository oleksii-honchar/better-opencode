#!/bin/bash

CONFIG_PATH="$HOME/.config/opencode/opencode.json"
WORK_DIR="/tmp"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Error: Config file not found at $CONFIG_PATH"
  exit 1
fi

# Parse config and list servers
SERVERS=$(python3 -c "
import json, sys

with open('$CONFIG_PATH', 'r') as f:
    config = json.load(f)

mcp = config.get('mcp', {})
servers = []

for name, srv in mcp.items():
    if srv.get('enabled', False):
        servers.append((name, srv.get('type', 'local')))

for i, (name, stype) in enumerate(servers, 1):
    print(f'{i}|{name}|{stype}')
" 2>&1)

if [[ $? -ne 0 ]] || [[ -z "$SERVERS" ]]; then
  echo "Error: Could not parse MCP servers from config"
  exit 1
fi

echo "Available MCP servers:"
echo "----------------------------------------"
echo "$SERVERS" | while IFS='|' read -r idx name stype; do
  echo "  $idx. $name ($stype)"
done
echo

# Get selection
if [[ -t 0 ]]; then
  echo -n "Select a server number to inspect: "
  read choice
else
  read choice
fi

if [[ -z "$choice" ]]; then
  echo "No selection made"
  exit 1
fi

# Get server name and type by index
SERVER_NAME=$(echo "$SERVERS" | sed -n "${choice}p" | cut -d'|' -f2)
SERVER_TYPE=$(echo "$SERVERS" | sed -n "${choice}p" | cut -d'|' -f3)

if [[ -z "$SERVER_NAME" ]]; then
  echo "Invalid selection: $choice"
  exit 1
fi

echo ""
echo "Inspecting server: $SERVER_NAME ($SERVER_TYPE)"
echo ""

python3 << PYEOF
import json, subprocess, os, sys, urllib.request, urllib.error

with open('$CONFIG_PATH', 'r') as f:
    config = json.load(f)

srv = config['mcp']['$SERVER_NAME']
server_type = srv.get('type', 'local')

def _remote_jsonrpc(url, method, params, headers, timeout=30):
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
            data_str = line[6:]
        elif line.startswith("data:"):
            data_str = line[5:]
        else:
            continue
        try:
            data = json.loads(data_str)
            responses.append(data)
        except json.JSONDecodeError:
            continue

    if responses:
        return responses[-1]

    # Fallback: try parsing as plain JSON (some servers return JSON directly)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f"No SSE data received. Raw response: {raw[:500]}")

if server_type == 'remote':
    url = srv.get('url', '')
    headers = srv.get('headers', {})
    print(f"URL: {url}")
    print(f"Headers: {list(headers.keys())}")
    print()
    print("Fetching tools via remote MCP endpoint...")
    print()

    try:
        response = _remote_jsonrpc(url, "tools/list", {}, headers)
        tools = response.get("result", {}).get("tools", [])
        print("Available tools:")
        print("-" * 40)
        for t in tools:
            print(f"  {t['name']}")
    except Exception as e:
        print(f"Error: {e}")
else:
    cmd = srv.get('command', [])
    env = srv.get('environment', {})

    print(f"Command: {' '.join(cmd)}")
    print(f"Environment keys: {list(env.keys())}")
    print()
    print("Running MCP inspector (this may take a moment)...")
    print()

    # Build full env
    full_env = {**os.environ}
    for k, v in env.items():
        full_env[k] = v

    # Run inspector from /tmp to avoid local package.json conflicts
    result = subprocess.run(
        ['npx', '-y', '@modelcontextprotocol/inspector', '--cli', '--method', 'tools/list', '--'] + cmd,
        env=full_env,
        capture_output=True,
        text=True,
        timeout=60,
        cwd='/tmp'
    )
    output = result.stdout

    # Extract tool names using jq
    import tempfile
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        f.write(output)
        temp_path = f.name

    try:
        proc = subprocess.run(
            ['jq', '-r', '.result.tools[].name', temp_path],
            capture_output=True, text=True, timeout=10
        )
        if proc.returncode == 0 and proc.stdout.strip():
            print("Available tools:")
            print("-" * 40)
            for line in proc.stdout.strip().split('\n'):
                print(f"  {line}")
        else:
            # Fallback: try .tools[].name (inspector format)
            proc2 = subprocess.run(
                ['jq', '-r', '.tools[].name', temp_path],
                capture_output=True, text=True, timeout=10
            )
            if proc2.returncode == 0 and proc2.stdout.strip():
                print("Available tools:")
                print("-" * 40)
                for line in proc2.stdout.strip().split('\n'):
                    print(f"  {line}")
            else:
                print("Could not parse tools from output:")
                print(output[:1000])
    finally:
        os.unlink(temp_path)

    # Show stderr warnings if any real errors (local servers only)
    if result.stderr:
        stderr_lines = [l for l in result.stderr.split('\n') if 'npm warn' not in l and l.strip()]
        if stderr_lines:
            print("\nWarnings:")
            for l in stderr_lines[:5]:
                print(f"  {l}")
PYEOF
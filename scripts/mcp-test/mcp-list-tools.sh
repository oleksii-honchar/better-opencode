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
    if srv.get('type') == 'local' and srv.get('enabled', False):
        servers.append(name)

for i, name in enumerate(servers, 1):
    print(f'{i}|{name}')
" 2>&1)

if [[ $? -ne 0 ]] || [[ -z "$SERVERS" ]]; then
  echo "Error: Could not parse MCP servers from config"
  exit 1
fi

echo "Available local MCP servers:"
echo "----------------------------------------"
echo "$SERVERS" | while IFS='|' read -r idx name; do
  echo "  $idx. $name"
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

# Get server name by index
SERVER_NAME=$(echo "$SERVERS" | sed -n "${choice}p" | cut -d'|' -f2)

if [[ -z "$SERVER_NAME" ]]; then
  echo "Invalid selection: $choice"
  exit 1
fi

echo ""
echo "Inspecting server: $SERVER_NAME"
echo ""

python3 << PYEOF
import json, subprocess, os

with open('$CONFIG_PATH', 'r') as f:
    config = json.load(f)

srv = config['mcp']['$SERVER_NAME']
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

# Always extract just tool names using jq
import tempfile

with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
    f.write(result.stdout)
    temp_path = f.name

try:
    proc = subprocess.run(
        ['jq', '-r', '.tools[].name', temp_path],
        capture_output=True, text=True, timeout=10
    )
    if proc.returncode == 0 and proc.stdout.strip():
        print("Available tools:")
        print("-" * 40)
        for line in proc.stdout.strip().split('\n'):
            print(f"  {line}")
    else:
        print("Full output (jq parse failed):")
        print(result.stdout[:500])
        if proc.stderr:
            print("jq error:", proc.stderr)
finally:
    os.unlink(temp_path)

# Show stderr warnings if any real errors
if result.stderr:
    stderr_lines = [l for l in result.stderr.split('\n') if 'npm warn' not in l and l.strip()]
    if stderr_lines:
        print("\nWarnings:")
        for l in stderr_lines[:5]:
            print(f"  {l}")
PYEOF
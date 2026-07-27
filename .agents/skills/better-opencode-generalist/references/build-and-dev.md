# Build and Dev — Quick Reference

Extracted from `~/www/misc/better-opencode/docs/GOVERNANCE.md` + `BETTER-OPENCODE.md`.

## Quick Install (Recommended)

```bash
cd ~/www/misc/better-opencode
./build-and-install.sh --install --clean
~/bin/better-opencode --version
```

This script: fetches latest upstream, rebases `patched/dev`, runs `bun install` + `bun turbo typecheck` + `bun run build`, installs binary to `~/bin/better-opencode`, configures OpenChamber.

## Build Commands

| Command | Purpose |
|---------|--------|
| `./build-and-install.sh --only-build` | Quick build (no install) |
| `./build-and-install.sh --install --clean` | Full build + install |
| `~/bin/better-opencode --version` | Verify build |

## Dev Server (Two-Tab Workflow)

### Tab A — Dev Server (foreground)

```bash
cd ~/www/misc/better-opencode
./scripts/start-dev.sh              # starts on port 4096
# optional: ./scripts/start-dev.sh --port 5000
```

- Runs `bun run --cwd packages/opencode ...` on **127.0.0.1**
- Leave this tab open; Ctrl+C stops the server
- Stop without the tab: `./scripts/start-dev.sh --stop`

### Tab B — IDE only

```bash
./scripts/start-dev.sh --ide-only           # VSCodium (default)
./scripts/start-dev.sh --ide-only --vscode  # VS Code
# Match Tab A if you changed the port:
./scripts/start-dev.sh --ide-only --port 5000
```

**Required once (User settings in VS Code / VSCodium):**
```json
"openchamber.apiUrl": "http://127.0.0.1:4096"
```

## OpenChamber Configuration

### Production (built binary)

In `~/.config/openchamber/settings.json`:
```json
{
  "opencodeBinary": "/Users/<user-name>/bin/better-opencode"
}
```

Or in `~/.zshrc` for CLI script:
```bash
export OPENCHAMBER_OPENCODE_PATH="/Users/<user-name>/bin/better-opencode"
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|-------|
| `BETTER_OPENCODE_DIR` | Repo path if not `~/www/misc/better-opencode` | `~/www/misc/better-opencode` |
| `OPENCODE_PORT` | Dev server port | `4096` |
| `NODE_EXTRA_CA_CERTS` | PEM bundle for internal HTTPS (Caddy, custom roots) | auto-load from `~/.config/better-opencode/extra-ca.pem` |
| `VSCODE_APP` | VSCode variant: `codium` or `code` | `codium` |
| `VSCODIUM_APP` / `VSCODIUM_APP_NAME` | macOS bundle path or `open -a` name overrides | — |

## Bun Setup

The project specifies `"packageManager": "bun@1.3.13"` in `package.json`.

```bash
# Install bun + specific version
curl -fsSL https://bun.sh/install | bash
bunvm install 1.3.13
bunvm alias default 1.3.13
```

Or from inside the project directory:
```bash
cd ~/www/misc/better-opencode
bun install   # auto-discovers bun@1.3.13 from packageManager field
```

## LiteLLM TLS / CA Trust

Bun does NOT use macOS Keychain for TLS trust. For Caddy self-signed certs:

**Option A — Environment variable (recommended):**
```bash
export NODE_EXTRA_CA_CERTS=/path/to/extra-ca.pem
```
The `start-dev.sh` script auto-loads from `~/.config/better-opencode/extra-ca.pem` if the file exists and the variable is unset.

**Option B — System keychain (macOS only, for non-Bun tools):**
```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /path/to/extra-ca.pem
```

### Setting up a new machine

```bash
mkdir -p ~/.config/better-opencode
scp user@primary-machine:~/.config/better-opencode/extra-ca.pem ~/.config/better-opencode/
echo '' >> ~/.zshrc
echo 'export NODE_EXTRA_CA_CERTS=~/.config/better-opencode/extra-ca.pem' >> ~/.zshrc
source ~/.zshrc
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Second `opencode serve` / random high port | `openchamber.apiUrl` not set (or wrong port) | Set to `http://127.0.0.1:4096` |
| `unable to get local issuer certificate` on chat / provider calls | Outbound HTTPS from Bun — CA not trusted | Add `NODE_EXTRA_CA_CERTS` or `extra-ca.pem` |
| IDE does not see `OPENCODE_PORT` on macOS | Use `codium` CLI or bundle binary launch; avoid relying on `open -a` alone for env |
| `tlsv1 alert internal error` / `FailedToOpenSocket` errno 0 | Connecting to raw IP instead of hostname (SNI mismatch) | Change `baseURL` from `https://<raw-IP>/v1` to `https://<your-litellm-hostname>/v1` |

## Tool Logging Debug

Opencode writes a JSONL tool log file: `~/.local/share/opencode/log/tools.log`.

Each line is a JSON object with `timestamp`, `type`, `arguments`, `result`, `duration_ms`, etc.

The `start-dev.sh` script supports tool log inspection via the `--tool-logs` flag:

```bash
# Pretty-print entire tools log
./scripts/start-dev.sh --tool-logs

# Filter: show only specific tool types
./scripts/start-dev.sh --tool-logs --include-tools bash,meta_use,grep

# Filter: exclude noisy tool types
./scripts/start-dev.sh --tool-logs --exclude-tools chat,read
```

The `--include-tools` and `--exclude-tools` accept comma-separated lists of `type` field values.

For manual inspection:
```bash
# Raw JSONL
cat ~/.local/share/opencode/log/tools.log

# Pretty-print single line
jq . <(sed -n '5p' ~/.local/share/opencode/log/tools.log)

# Filter by type
jq 'select(.type=="bash")' ~/.local/share/opencode/log/tools.log

# Last 20 entries
tail -20 ~/.local/share/opencode/log/tools.log | jq -c '{type, duration_ms}'
```

## Log File Locations

All log files are in `~/.local/share/opencode/log/`.

### Default Logs

| Log File | Source | Purpose |
|----------|--------|---------|
| `dev.log` | better-opencode | Dev server output (HTTP requests, plugin lifecycle, errors) |
| `opencode.log` | better-opencode | Core opencode runtime (sessions, chat, tool orchestration) |
| `agent-meta-tool.log` | agent-meta-tool | Meta-tool plugin (meta_search, meta_use, skill_search, split router) |
| `tools.log` | better-opencode | Tool execution log (all tool calls with args, results, duration) |

### Quick Log Inspection

```bash
# Dev server errors
tail -50 ~/.local/share/opencode/log/dev.log

# Meta-tool activity (meta_search / meta_use)
tail -50 ~/.local/share/opencode/log/agent-meta-tool.log

# Tool execution with errors
jq -c 'select(.error)' ~/.local/share/opencode/log/tools.log

# Last 20 meta-use calls
grep meta_use ~/.local/share/opencode/log/tools.log | tail -20 | jq -c '{type, name, duration_ms, error}'
```

### Feature-Specific Logs

Use `rg` to search for feature-specific log entries. Features include `tag` fields in their log output for filtering.

| Feature | Log File | Search Pattern |
|---------|----------|----------------|
| Dynamic Skills | `dev.log` | `rg "dynamic-scanner" ~/.local/share/opencode/log/dev.log` |
| Dynamic Skills (by tag) | `dev.log` | `rg '"tag":"dynamic-skills"' ~/.local/share/opencode/log/dev.log` |
| Skill Session Metadata | `dev.log` | `rg "session-metadata" ~/.local/share/opencode/log/dev.log` |

```bash
# Example: search dynamic skills activity
rg "dynamic-scanner" ~/.local/share/opencode/log/dev.log | tail -30
```
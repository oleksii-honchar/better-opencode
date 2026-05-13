# MCP Test Suite

Test suite for validating MCP (Model Context Protocol) servers configured in opencode.

## Folder Structure

```
mcp-test/
├── mcp-test.md              # This file — documentation
├── mcp-test.sh              # Main smoke test script (live JSON-RPC connections)
├── mcp-list-tools.sh        # Interactive tool — select server, list its tools
├── fixtures/                # Pre-captured tools/list responses per server
│   ├── github.json          # GitHub MCP server fixture
│   ├── mermaid-validator.json
│   ├── ...                  # One JSON per server (17 servers)
│   └── expected-results.json
```

## Scripts

### mcp-test.sh — Live Smoke Test (v4.0.0)

Tests MCP servers by connecting to them live via **direct JSON-RPC** (no inspector dependency).

**Protocol:**
- **Local (stdio)** servers: `initialize` → `notifications/initialized` → `tools/list` → `tools/call` (on first available tool)
- **Remote (HTTP)** servers: `ping` → `tools/list` → `tools/call` (on first available tool) via JSON-RPC over HTTP+SSE

**How it works:**
- Reads server definitions from `~/.config/opencode/opencode.json`
- For **local (stdio)** servers: Spawns the server process, communicates via stdin/stdout JSON-RPC
- For **remote (HTTP)** servers: Sends JSON-RPC requests via HTTP POST with SSE response parsing
- Auto-generates test arguments from tool `inputSchema` with context-aware defaults

**Checks performed:**
| Check | Local | Remote | Description |
|-------|-------|--------|-------------|
| `server-startup` | ✅ | ✅ | Server starts and is reachable (ping for remote) |
| `protocol-init` | ✅ | — | MCP `initialize` handshake succeeds |
| `tools-list` | ✅ | ✅ | `tools/list` returns valid tool list |
| `response-validity` | ✅ | ✅ | Response structure is valid |
| `tools-call` | ✅ | ✅ | Invokes first available tool with auto-generated args |

**Usage:**
```bash
./mcp-test.sh                          # Test all enabled servers
./mcp-test.sh --server github          # Test only GitHub server
./mcp-test.sh --category database      # Test only database servers
./mcp-test.sh --all --json             # All servers (incl. disabled), JSON output
```

**CLI flags:**
| Flag | Description |
|------|-------------|
| `--all` | Include disabled servers |
| `--server <name>` | Test only specified server (repeatable) |
| `--category <cat>` | Filter by category |
| `--json` | Output in JSON format |
| `--config <path>` | Custom opencode config path |
| `--quiet` | Suppress verbose output |
| `--no-color` | Disable colored output |
| `--help` | Show help |
| `--version` | Show version |

**Exit codes:**
- `0` — All servers passed
- `1` — One or more servers failed
- `2` — Configuration error

### mcp-list-tools.sh — Interactive Tool Lister

Interactive script that lets you select a server from the config and lists its available tools.

**How it works:**
- Reads local (stdio) servers from `~/.config/opencode/opencode.json`
- Prompts you to select a server number
- Runs `@modelcontextprotocol/inspector --cli --method tools/list` and extracts tool names via `jq`

**Usage:**
```bash
./mcp-list-tools.sh
```

## Fixtures

Pre-captured `tools/list` responses for each MCP server. Used for:
- Quick validation without live connections
- Cross-referencing expected tool counts
- Future fixture-based testing

Each fixture file contains:
```json
{
  "tools_list_response": {
    "tools": [
      {
        "name": "search_code",
        "description": "Search code across GitHub repositories",
        "inputSchema": { ... },
        "shouldTest": true
      }
    ]
  },
  "expected": {
    "server_startup": "passed",
    "tools_list": "passed",
    "response_validity": "passed",
    "tool_count": 26
  }
}
```

**Note:** Server definitions (type, url, command, headers, etc.) are **not** stored in fixtures — they come from `~/.config/opencode/opencode.json` as the single source of truth. Fixtures only contain pre-captured `tools/list` responses and expected results.

## Remote Server Testing

### Implementation

Remote servers are tested using **direct JSON-RPC HTTP calls** with SSE response parsing:

```python
# Ping for connectivity
_remote_jsonrpc(url, "ping", {}, headers, timeout)

# Tools list
_remote_jsonrpc(url, "tools/list", {}, headers, timeout)

# Tool invocation
_remote_jsonrpc(url, "tools/call", {"name": tool_name, "arguments": args}, headers, timeout)
```

SSE responses are parsed by extracting `data:` lines and parsing JSON from each.

### Tested Remote Servers

| Server | URL | Auth | Status |
|--------|-----|------|--------|
| github | `https://api.githubcopilot.com/mcp/` | Bearer token | ✅ PASS |
| context7 | `https://mcp.context7.com/mcp` | x-api-key header | ✅ PASS |
| paperless | `https://lite-llm.lan/mcp/paperless` | Bearer token | ✅ PASS |
| kreuzberg | `https://lite-llm.lan/mcp/kreuzberg` | Bearer token | ✅ PASS |
| notion | `https://mcp.notion.com/mcp` | None | ❌ FAIL (Cloudflare 403) |

### Key Protocol Details

- Remote servers use SSE: parse `data:` lines, strip `data: ` prefix, parse JSON
- Some remote servers require `Accept: application/json, text/event-stream` header
- Environment variables from config need to be mapped to headers (e.g., `CONTEXT7_API_KEY` → `x-api-key`)
- The `ping` method is used for connectivity checks (HEAD doesn't work on MCP endpoints)

## Auto-Generated Test Arguments

The script auto-generates test arguments from tool `inputSchema` using context-aware defaults:

| Property Name | Default Value |
|---------------|---------------|
| `markdown` | `# Test\n\nThis is a test markdown document.` |
| `diagram` | `graph TD; A-->B;` |
| `query` | `test` |
| `library` / `libraryName` | `express` |
| `name` | `test-name` |
| `path` | `README.md` |
| `owner` | `test-owner` |
| `repo` | `test-repo` |
| `format` | `svg` (or first enum value) |
| Other strings | `test_{prop_name}` |
| Integers | `1` |
| Booleans | `true` |
| Arrays | `[]` |
| Objects | `{}` |

If a schema has no `required` field (some servers omit it), the first string property is included as a fallback.

## MCP Server Inventory

| Server | Type | Transport | Tools | Category |
|--------|------|-----------|-------|----------|
| mermaid-validator | local | stdio | 1 | validation |
| perplexity | local | stdio | 4 | research |
| context7 | remote | HTTP | 2 | research |
| data-dog | local | stdio | 21 | observability |
| pg-billing-engine | local | stdio | ? | database |
| pg-payments | local | stdio | ? | database |
| github | remote | HTTP | 41 | development |
| serper | local | stdio | 2 | research |
| chrome-devtools | local | stdio | 10 | browser |
| Atlassian-Rovo-MCP | local | stdio | 16 | office |
| browser-mcp | local | stdio | 2 | browser |
| notion | remote | HTTP | ? | office |
| mongodb-mcp-server | local | stdio | ? | database |
| md-to-html | local | stdio | 1 | office |
| slack | local | stdio | 11 | office |
| mcp-server-snowflake | local | stdio | ? | database |
| octocode | local (disabled) | stdio | ? | development |
| paperless | remote | HTTP | 32 | documents |
| kreuzberg | remote | HTTP | ? | documents |

**Total:** 19 servers (17 enabled, 2 disabled), 14 local + 5 remote

## Known Limitations

- Servers that require specific database connections (pg-billing-engine, pg-payments, mongodb, snowflake) will fail if the DB is not available
- The `tools-call` check passes if the server returns a valid JSON-RPC `result`, even if the content is an error message (protocol-level success, not business-logic success)
- Some servers (octocode) send notifications before responses — handled by skipping messages without `id` field
- The `--deep` flag (Phase 2: additional checks) is not yet implemented
- Chrome debug auto-spawn: For `chrome-devtools` server, the script checks if port 9222 is open. If not, it spawns Chrome with `--remote-debugging-port=9222 --disable-web-security --user-data-dir=~/chrome-debug-profile`. Subsequent runs reuse the existing Chrome instance.

---
feature: static-mcp-filtering
version: 2.0.0
status: proposed
source: architect/spec.md (session 260502-1709-tools-context-management)
pr: N/A
implementation: pending
---

# Spec: Static MCP Server Filtering by Category and Tool

> **v2.0.0** — Added per-tool filtering (enabledTools / disabledTools) in addition to server-level category filtering.

## Problem Statement

The current opencode configuration exposes **150+ tool definitions** to **every agent session** regardless of relevance. This creates **~225,000 tokens of context pollution per session** (conservative estimate), wasting context window space and potentially exposing sensitive capabilities.

**Root cause:** opencode's MCP system has no per-agent or per-session filtering mechanism. MCP servers are defined globally in `opencode.json` and loaded wholesale into every agent's context.

## Design Decision

**Two-tier filtering: server-level category + per-tool whitelist/blacklist.**

### Tier 1: Server-Level Category Filtering

- Each MCP server optionally declares a `category` string in `opencode.json`
- Each agent frontmatter declares an `allowedMcpCategories` array
- At agent spawn, only MCP servers whose category matches are loaded
- No predefined categories — the user defines them freely
- No dynamic gate, no approval flows, no agent type registry file

### Tier 2: Per-Tool Filtering

- Each MCP server optionally declares `enabledTools` (whitelist) or `disabledTools` (blacklist)
- Tool filtering applies **after** category filtering — if the server is excluded by category, tool filtering is not evaluated
- `enabledTools` and `disabledTools` are **mutually exclusive** — cannot use both simultaneously
- If both are specified, `enabledTools` takes precedence with a warning logged
- Tool names must match **exactly** (case-sensitive, raw MCP tool names — not sanitized)
- If all tools are filtered out, a warning is logged and no tools from that server are available

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Agent Spawn Flow                         │
│                                                              │
│  1. Read agent frontmatter → get allowedMcpCategories[]      │
│  ┌──────────────────────────────────────────┐                │
│  │  name: "developer"                       │                │
│  │  allowedMcpCategories: ["core", "code",  │                │
│  │    "observability", "browser"]           │                │
│  └──────────────────┬───────────────────────┘                │
│                     │                                        │
│  2. Read MCP servers → match by category                     │
│  ┌──────────────────────────────────────────┐                │
│  │  MCP Server    │ Category   │ Match?     │                │
│  │  ──────────────┼────────────┼────────────│                │
│  │  core          │ core       │ ✅          │                │
│  │  github        │ code       │ ✅          │                │
│  │  datadog       │ observability │ ✅      │                │
│  │  browser       │ browser    │ ✅          │                │
│  │  slack         │ office     │ ❌          │                │
│  │  atlassian     │ office     │ ❌          │                │
│  │  perplexity    │ search     │ ❌          │                │
│  │  context7      │ docs       │ ❌          │                │
│  └──────────────────┬───────────────────────┘                │
│                     │                                        │
│  3. Load only matched MCP servers → inject to agent          │
│  ┌──────────────────────────────────────────┐                │
│  │  Tools loaded: core + github + datadog + browser │        │
│  │  Context saved: ~120,000 tokens          │                │
│  └──────────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────┘
```

## Data Models

### 1. MCP Server Configuration (`opencode.json`)

**Data Model:**

```typescript
interface McpServerConfig {
  name: string;              // MCP server name (key in opencode.json)
  enabled: boolean;
  category?: string;         // Optional user-defined category string
  // ... existing MCP config fields
}
```

**Example:**

```jsonc
// opencode.json — user adds optional "category" property to MCP server config
{
  "mcp": {
    "github": {
      "enabled": true,
      "category": "code"
    },
    "datadog": {
      "enabled": true,
      "category": "observability"
    }
    // Servers without "category" are loaded for all agents (backward-compatible)
  }
}
```

**Key Points:**
- `category` is **optional** — if missing, the MCP server is **loaded for all agents** (backward-compatible default)
- Category values are **free strings** — no enum, no predefined set
- User can name categories however they want: "code", "dev-tools", "infra", whatever fits

### 2. Agent Frontmatter

```yaml
# agents/developer.md
name: developer
displayName: Developer
description: Implements features and fixes through code
allowedMcpCategories: [core, code, observability, browser]
sessionTimeout: 720
```

```yaml
# agents/researcher.md
name: researcher
displayName: Researcher
description: Investigates problems through code search and analysis
allowedMcpCategories: [core, search, docs]
sessionTimeout: 720
```

```yaml
# agents/session-manager.md
name: session-manager
displayName: Session Manager
description: Orchestrates session lifecycle and agent handoffs
allowedMcpCategories: [core]
sessionTimeout: 480
```

**Key Points:**
- `allowedMcpCategories` is an **array of strings** — must match MCP server `category` values
- If empty or missing → agent gets **no MCP tools** (only core built-ins)
- No agent type registry file — configuration lives in agent frontmatter

### 3. Filtering Logic

**Algorithm:**

```
1. Agent spawn → read allowedMcpCategories from agent frontmatter
2. For each MCP server:
   a. Read MCP server's category
   b. If category is missing → load all tools (backward-compatible default)
   c. If category is in allowedMcpCategories → load all tools from this MCP server
   d. If category is not matched → skip this MCP server
```

**Filtering function (inline in MCP.tools()):**

```typescript
// Inside MCP.tools(agent?):
const allowed = agent?.allowedMcpCategories

// For each connected MCP server:
if (allowed && allowed.length > 0) {
  const serverCategory = entry?.category
  if (serverCategory && !allowed.includes(serverCategory)) {
    return // skip this MCP server
  }
  // If no category, load for all agents (backward-compatible)
}
```

**Example — Developer Agent Spawn:**

```typescript
// Agent frontmatter
const agent = {
  name: 'developer',
  allowedMcpCategories: ['core', 'code', 'observability', 'browser'],
};

// MCP servers
const allServers = [
  { name: 'core',        category: 'core' },
  { name: 'github',      category: 'code' },
  { name: 'datadog',     category: 'observability' },
  { name: 'browser',     category: 'browser' },
  { name: 'slack',       category: 'office' },
  { name: 'atlassian',   category: 'office' },
  { name: 'perplexity',  category: 'search' },
  { name: 'context7',    category: 'docs' },
];

// Result — only matching servers loaded
// → core, github, datadog, browser (4 servers)
// → slack, atlassian, perplexity, context7 filtered out
```

### 4. Integration Point

**Filtering happens inside `MCP.tools()`** in `packages/opencode/src/mcp/index.ts`.

**Why here?** Three options were evaluated:
1. **Filter at `MCP.tools()`** (chosen) — Minimal changes, agent context already available at call site
2. **Filter at MCP initialization** — Too complex, MCP state is shared across all agents
3. **Filter at `ToolRegistry.tools()`** — Wrong layer, MCP tools are loaded separately in `prompt.ts`

**Call site in `session/prompt.ts`:**

```typescript
// Before:
for (const [key, item] of Object.entries(yield* mcp.tools())) {

// After:
for (const [key, item] of Object.entries(yield* mcp.tools(input.agent))) {
```

### 5. Context Injection Flow

```
1. Session starts → read nextAgent from session.md
2. Read agent frontmatter → get allowedMcpCategories
3. MCP.tools(agent) → filter MCP servers by category
4. Load tools from matching MCP servers only
5. Inject tools into agent system prompt
```

## Tool-Level Filtering

### Configuration Options

Both `enabledTools` (whitelist) and `disabledTools` (blacklist) are optional fields on MCP server configuration. They apply to **both** Local and Remote MCP server types.

| Field | Type | Description |
|-------|------|-------------|
| `enabledTools` | `string[]` | **Whitelist** — only these tool names will be loaded from the MCP server |
| `disabledTools` | `string[]` | **Blacklist** — these tool names will be excluded from the MCP server |

### Filtering Order

1. **Category filter** — Server-level agent filtering (existing)
2. **Tool filter** — Per-tool whitelist/blacklist (new)

Both filters are applied in sequence. If category filter excludes the server, tool filter is not evaluated.

### Mutual Exclusion

The `enabledTools` and `disabledTools` fields cannot both be specified. If both are present, a warning is logged and `enabledTools` takes precedence.

### Empty Tool List

If all tools are filtered out, a warning is logged and no tools from that server are available.

### Example: enabledTools (Whitelist)

Only the specified tools will be loaded from the MCP server.

```jsonc
{
  "mcp": {
    "datadog": {
      "type": "local",
      "command": ["npx", "@datadog-mcp/server"],
      "enabled": true,
      "category": "observability",
      "enabledTools": [
        "search_datadog_dashboards",
        "search_datadog_events"
      ]
    }
  }
}
```

### Example: disabledTools (Blacklist)

The specified tools will be excluded from the MCP server.

```jsonc
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "@modelcontextprotocol/server-github"],
      "enabled": true,
      "category": "development",
      "disabledTools": [
        "merge_pull_request",
        "create_repository"
      ]
    }
  }
}
```

### Example: Combined Category + Tool Filtering

Both filters work together — only tools from matching servers are loaded, and within those servers, only matching tools are included.

```jsonc
{
  "mcp": {
    "datadog": {
      "type": "local",
      "command": ["npx", "@datadog-mcp/server"],
      "enabled": true,
      "category": "observability",
      "enabledTools": [
        "search_datadog_dashboards",
        "search_datadog_events"
      ]
    },
    "github": {
      "type": "local",
      "command": ["npx", "@modelcontextprotocol/server-github"],
      "enabled": true,
      "category": "development",
      "disabledTools": [
        "merge_pull_request"
      ]
    }
  }
}
```

```yaml
# agents/developer.md
name: developer
displayName: Developer
description: Implements features and fixes through code
allowedMcpCategories: [core, code, observability, browser]
sessionTimeout: 720
```

**Result:** Developer gets:
- `search_datadog_dashboards` (observability category + whitelisted tool)
- `search_datadog_events` (observability category + whitelisted tool)
- `github_*` tools **except** `merge_pull_request` (development category + blacklisted tool excluded)

### Filtering Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                  MCP.tools(agent) — Filtering Flow            │
│                                                              │
│  For each MCP server:                                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 1. Category Filter                                       │ │
│  │    ┌───────────────────────────────────────────────────┐ │ │
│  │    │ Server category missing? → Load ALL tools         │ │ │
│  │    │ Server category matches agent? → Continue to 2     │ │ │
│  │    │ Server category doesn't match → SKIP server        │ │ │
│  │    └───────────────────────────────────────────────────┘ │ │
│  │                                                         │ │
│  │ 2. Tool Filter                                           │ │
│  │    ┌───────────────────────────────────────────────────┐ │ │
│  │    │ enabledTools specified? → Whitelist filter        │ │ │
│  │    │ disabledTools specified? → Blacklist filter       │ │ │
│  │    │ Both specified? → enabledTools wins (warn)        │ │ │
│  │    │ All tools filtered? → SKIP server (warn)          │ │ │
│  │    └───────────────────────────────────────────────────┘ │ │
│  │                                                         │ │
│  │ 3. Return filtered tools                                 │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Expected Context Reduction

| Agent | Current Tools | Filtered Tools | Context Saved |
|-------|--------------|----------------|---------------|
| session-manager | 150+ | ~15 | **90%** |
| researcher | 150+ | ~40 | **73%** |
| architect | 150+ | ~55 | **63%** |
| developer | 150+ | ~80 | **47%** |
| reviewer | 150+ | ~55 | **63%** |
| documenter | 150+ | ~80 | **47%** |
| worker | 150+ | ~35 | **77%** |

## Implementation Plan

### Phase 1: Schema Changes (4 files, ~7 lines)

**1.1 — Add `category` to MCP config** (`packages/opencode/src/config/mcp.ts`)
- Add `category?: string` to both `Local` and `Remote` structs

**1.2 — Add `allowedMcpCategories` to agent config** (`packages/opencode/src/config/agent.ts`)
- Add to `AgentSchema` struct and `KNOWN_KEYS` set

### Phase 2: Core Filtering (~10 lines)

**2.1 — Modify `MCP.tools()`** (`packages/opencode/src/mcp/index.ts`)
- Change signature: `tools: (agent?: Agent.Info) => Effect.Effect<Record<string, Tool>>`
- Add import for `Agent`
- Add filter logic inside forEach loop

### Phase 3: Call Site (1 line)

**3.1 — Pass agent to `mcp.tools()`** (`packages/opencode/src/session/prompt.ts`)
- Change `yield* mcp.tools()` to `yield* mcp.tools(input.agent)`

### Phase 4: Config (User-Driven)

**4.1 — Assign categories to MCP servers** in `opencode.json`
**4.2 — Add `allowedMcpCategories` to agent frontmatter**

**Total code changes: ~18 lines across 4 files.**

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Agent needs a tool from filtered MCP | High | Feature flag — disable filtering per-session |
| Agent frontmatter missing `allowedMcpCategories` | Medium | Agent gets no MCP tools (safe default) |
| Category mismatch (typo) | Low | Debug logging shows which servers matched/filtered |

## Open Questions

1. **Feature flag:** Per-session or global toggle? — Not required for v1; filtering is opt-in via config.
2. **Core tools:** Should core built-in tools (bash, read, write, edit, glob, grep, compress) always be loaded regardless of filtering? — Yes, core tools are always loaded (they are not MCP tools).

---

*Specification authored: 2026-05-02*
*Source: session 260502-1709-tools-context-management*

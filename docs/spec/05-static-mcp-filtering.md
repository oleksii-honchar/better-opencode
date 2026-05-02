---
feature: static-mcp-filtering
version: 1.0.0
status: proposed
source: architect/spec.md (session 260502-1709-tools-context-management)
pr: N/A
implementation: pending
---

# Spec: Static MCP Server Filtering by Category

## Problem Statement

The current opencode configuration exposes **150+ tool definitions** to **every agent session** regardless of relevance. This creates **~225,000 tokens of context pollution per session** (conservative estimate), wasting context window space and potentially exposing sensitive capabilities to agents that shouldn't have access.

**Root cause:** opencode's MCP system has no per-agent or per-session filtering mechanism. MCP servers are defined globally in `opencode.json` and loaded wholesale into every agent's context.

## Design Decision

**Static MCP server filtering by user-defined category.**

- Each MCP server optionally declares a `category` string in `opencode.json`
- Each agent frontmatter declares an `allowedMcpCategories` array
- At agent spawn, only MCP servers whose category matches are loaded
- No predefined categories — the user defines them freely
- No dynamic gate, no approval flows, no agent type registry file

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

**Example:**

```jsonc
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

```typescript
function filterMcpServersForAgent(
  allowedCategories: string[],
  mcpServers: McpServerConfig[]
): McpServerConfig[] {
  const allowed = new Set(allowedCategories);

  return mcpServers.filter(server =>
    server.enabled
    && (server.category == null || allowed.has(server.category))
  );
}
```

**Algorithm:**
1. Read agent type from `session.md` (`nextAgent` field)
2. Read agent frontmatter → get `allowedMcpCategories[]`
3. For each MCP server:
   - If `category` is in `allowedMcpCategories` → load all tools from this MCP server
   - If `category` is missing → load all tools (backward-compatible default)
   - If `category` is not matched → skip this MCP server
4. Inject loaded tools into agent context

### 4. Context Injection Flow

```
1. Session starts → read nextAgent from session.md
2. Read agent frontmatter → get allowedMcpCategories
3. Filter MCP servers → get matching servers
4. Load tools from matching MCP servers only
5. Inject tools into agent system prompt
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

### Phase 1: Foundation

**Tasks:**
1. Add optional `category` field to MCP server config schema in `opencode.json`
2. Add `allowedMcpCategories` field to agent frontmatter schema
3. Create `filterMcpServersForAgent()` function
4. User assigns categories to existing MCP servers

### Phase 2: Integration

**Tasks:**
1. Modify agent spawn logic to read `allowedMcpCategories` from agent frontmatter
2. Filter MCP servers → load only matching tools
3. Add debug logging (which servers matched/filtered per agent spawn)

### Phase 3: Testing & Rollout

**Tasks:**
1. Test each agent — verify correct tools loaded
2. Measure context size reduction per agent
3. Feature flag for gradual rollout
4. Update documentation

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Agent needs a tool from a filtered MCP server | High | Feature flag — disable filtering per-session |
| MCP server has no `category` | Medium | Loaded for all agents (backward-compatible default) |
| Agent frontmatter missing `allowedMcpCategories` | Medium | Agent gets no MCP tools (safe default) |
| Category mismatch (typo) | Low | Debug logging shows which servers matched/filtered |

## Open Decisions

1. **Default behavior:** If an MCP server has no `category`, should it be loaded (backward compat) or skipped (safe)? Current design: **loaded for all agents** (backward-compatible).
2. **Feature flag:** Per-session or global toggle?
3. **Core tools:** Should core built-in tools (bash, read, write, edit, glob, grep, compress) always be loaded regardless of filtering?

---

*Specification authored: 2026-05-02*
*Source: session 260502-1709-tools-context-management*

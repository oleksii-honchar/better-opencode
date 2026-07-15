# Fork Features — Quick Reference

Extracted from `~/www/misc/better-opencode/docs/FEATURES.md`.

## Feature List

| # | Feature | Status | Spec |
|---|---------|--------|------|
| 1 | `tool.execute.after` Inject | ✅ Implemented | spec/02-tool-execute-after-inject.md |
| 2 | `session.stopping` Hook | ⏳ Pending (PR #16598 unmerged upstream) | spec/03-session-stopping-hook.md |
| 3 | Session ID in System Prompt | ✅ Implemented | spec/01-session-id-system-prompt.md |
| 4 | Multi-Repo Worktree Discovery | ⏳ Pending (new feature proposal) | spec/04-multi-repo-worktree-discovery.md |
| 5 | Static MCP Server Filtering by Category and Tool | ✅ Implemented | spec/05-static-mcp-filtering.md |
| 6 | Attachment Resolution | ✅ Implemented | spec/07-attachment-resolution.md |

## Feature Details

### 1. `tool.execute.after` Inject (PR #19519)
Plugins inject synthetic user messages after tool execution. Persisted and visible to AI on next loop iteration.


### 2. `session.stopping` Hook (PR #16598)
Plugins intercept idle/stop state and inject follow-up messages instead of stopping.

**Status:** ⏳ Pending — PR #16598 is unmerged upstream. Patch may not apply cleanly to current upstream.

### 3. Session ID in System Prompt
`sessionID` and `parentSessionID` included in `<env>` block on every LLM call. Survives compaction because system prompt is rebuilt each turn.

**Files:** `packages/opencode/src/session/system.ts`

### 4. Multi-Repo Worktree Discovery
Agent discovers and enumerates all related git repos in `<env>` block. Enables intelligent navigation across repo boundaries.

**Status:** ⏳ Pending — New feature proposal, not yet implemented.

### 5. Static MCP Server Filtering by Category and Tool
Two-tier filtering to reduce context pollution from 150+ tools:
1. **Server-level category filtering** — `category` field on MCP servers, `allowedMcpCategories` on agents
2. **Per-tool filtering** — `enabledTools` (whitelist) or `disabledTools` (blacklist) per server

**Result:** Developer agent gets ~80 tools instead of 150+ (47% reduction).

**Files:** `packages/opencode/src/config/mcp.ts`, `packages/opencode/src/config/agent.ts`, `packages/opencode/src/mcp/index.ts`

### 6. Attachment Resolution
Vision models can *see* images but cannot *extract* base64 for tool calls. Solution: store as temp files with `opencode://attachment/<uuid>.<ext>` URIs, inject URI references as synthetic text parts, intercept MCP tool execution to resolve URIs to base64.

**Flow:** User attaches image → resolvePart stores temp file + generates URI → Prompt includes FilePart(visual) + synthetic text → LLM calls extract_bytes(data: "opencode://attachment/abc123.png") → convertMcpTool intercepts, resolves URI → base64 → success.

**Files:** `packages/opencode/src/session/attachment.ts`, `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/mcp/index.ts`

## Deferred Features
- **Docker packaging** — Multi-stage build for reproducible distribution (postponed)
- **Oh-my-openagent hash-edit tool** — Hash-anchored file editing for maximum precision (~500+ line project, deferred to Phase 5)

</content>, 
---
type: adr
id: ADR-0054
title: "Inclusion-Based Opt-In for MCP File Path Base64 Encoding"
status: accepted
createdAt: "2026-07-17T12:00:00Z"
updatedAt: "2026-07-17T12:00:00Z"
tags: [mcp, base64, file-path, attachment, inclusion]
supersedes: []
superseded_by: []
see_also:
  - "[[0033-absolute-directory-mcp-arguments.adr]]"
  - "[[0053-lenient-json-schema-validator.adr]]"
  - "[[memories/0005-mcp-absolute-directory-argument-gotcha.memory]]"
---

# ADR-0054: Inclusion-Based Opt-In for MCP File Path Base64 Encoding

## Context

`resolveAttachmentUris()` in `packages/opencode/src/mcp/index.ts` blindly converted ALL absolute file paths in MCP tool arguments to base64 content before forwarding. For `octocode_localGetFileContent`, the `path` argument was replaced with base64-encoded file content, which the tool interpreted as a filesystem path → "Path name too long".

Only `hugging-kreuzberg` (OCR/image MCP server) actually needs base64-encoded file payloads. The legacy behavior of converting all paths broke tools whose arguments are paths, not content.

## Decision

Replace legacy "convert all" behavior with inclusion-based `features.mcpFilePathBase64Encode` config:

```json
{
  "features": {
    "mcpFilePathBase64Encode": {
      "enable": true,
      "includeMCP": ["hugging-kreuzberg"]
    }
  }
}
```

**Behavior matrix:**

| Config state | File path resolution |
|-------------|---------------------|
| No config present | Legacy: resolve all paths (backward compat) |
| `enable: false` | No file-path resolution for any tool |
| `includeMCP: []` (empty) | Legacy: resolve all paths (backward compat) |
| `includeMCP: ["hugging-kreuzberg"]` | Only listed MCP servers get base64 resolution |

**`opencode://attachment/` URIs** always resolve regardless of inclusion — these are always valid attachment references.

**Gate function:** `shouldResolveFilePath(AttachmentResolutionOptions)` at `packages/opencode/src/mcp/index.ts:259-265` implements the inclusion logic.

**Config schema:** `McpFilePathBase64Encode` in `packages/opencode/src/config/features.ts` with `enable` (boolean, optional) and `includeMCP` (string[], optional).

## Alternatives Considered

| Alternative | Rejection Reason |
|-------------|------------------|
| Exclusion-based config (`excludeMCP`) | Negative thinking, breaks new tools as they are added, requires knowing all tools upfront |
| Tool-name exclusion (`excludeTools`) | Too granular, tool names can change, fragile to server updates |
| Schema-aware resolution (inspect arg type) | Complex, requires understanding of each tool's schema at runtime |
| Fix at tool definition level | Doesn't help third-party MCP servers |

## Consequences

**Positive:**
- New MCP tools work out of the box (only listed servers get encoding)
- Backward compatible (no config → legacy behavior)
- Config is explicit and auditable
- Matches the actual use case (only `hugging-kreuzberg` needs encoding)

**Negative:**
- If new MCP servers need encoding, config must be updated
- Requires understanding of which servers need encoding

## Implementation Status

- ✅ Config schema in `packages/opencode/src/config/features.ts` (5/5 schema tests)
- ✅ Gate function `shouldResolveFilePath` in `packages/opencode/src/mcp/index.ts:259-265`
- ✅ `AttachmentResolutionOptions` interface in `packages/opencode/src/mcp/index.ts:242-249`
- ✅ Wired into `convertMcpTool` via 4th parameter (`toolOptions`)
- ✅ Both call sites in `tools()` pass features config
- ✅ 18 inclusion-based unit tests passing
- ✅ 39/39 MCP tests passing, typecheck clean
- ⏳ E2E validation with octocode MCP tools pending

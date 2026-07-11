---
type: adr
title: "Pass Existing Absolute Directory MCP Arguments Through Unchanged"
createdAt: "2026-07-10T15:35:00Z"
updatedAt: "2026-07-10T15:35:00Z"
tags: [mcp, attachments, octocode, meta-tools]
id: ADR-0033
status: accepted
see_also:
  - "[[0007-meta-use-octocode-absolute-paths.spec]]"
  - "[[0005-mcp-absolute-directory-argument-gotcha.memory]]"
---

# Pass Existing Absolute Directory MCP Arguments Through Unchanged

## Context

`convertMcpTool()` in `packages/opencode/src/mcp/index.ts` calls `resolveAttachmentUris(args)` before forwarding arguments to `client.callTool()`.

`resolveAttachmentUris()` recursively walks tool arguments. Before this fix, every absolute string was treated as a candidate local file attachment. That broke MCP tools whose schemas use absolute directory strings as data. Octocode local tools commonly receive absolute directories in nested fields such as `queries[].path`.

The observed runtime failure was:

```text
Failed to read file: /Users/oleksii.honchar/www/misc/agent-meta-tool — Not a regular file: /Users/oleksii.honchar/www/misc/agent-meta-tool
```

This happened before Octocode received the request.

## Decision

Keep recursive attachment resolution, but treat existing absolute directories as literal argument values:

- `opencode://attachment/*` remains resolved through the attachment store.
- Existing absolute regular files remain converted to base64 with the existing size limit.
- Existing absolute directories pass through unchanged.
- Missing absolute paths pass through unchanged for write-destination use cases.
- Other non-file path failures still raise `Failed to read file: ...`.

## Alternatives Considered

1. **Remove absolute file-path conversion entirely** — rejected because existing attachment/file workflows depend on it.
2. **Special-case Octocode in `agent-meta-tool`** — rejected because the bug is in OpenCode MCP argument preprocessing, not in the meta-tool delegator.
3. **Require relative paths for Octocode calls** — rejected because agents and MCP tools legitimately use absolute workspace paths.
4. **Schema-aware attachment conversion** — deferred; safer long-term, but larger than this fix.

## Consequences

- MCP tools can receive literal absolute directory arguments.
- `meta_use` can call Octocode local tools with absolute `queries[].path` values once the patched OpenCode runtime is installed and restarted.
- Existing absolute file attachment conversion remains unchanged.
- A future MCP tool that wants a literal existing absolute file path still conflicts with attachment conversion; that remains a known limitation.

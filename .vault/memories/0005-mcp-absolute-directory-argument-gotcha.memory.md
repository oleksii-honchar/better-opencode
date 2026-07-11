---
type: memory
title: "MCP Absolute Directory Arguments Can Be Mistaken for Attachment Files"
createdAt: "2026-07-10T15:35:00Z"
updatedAt: "2026-07-10T15:35:00Z"
tags: [mcp, octocode, attachments, debugging]
see_also:
  - "[[0033-absolute-directory-mcp-arguments.adr]]"
  - "[[0007-meta-use-octocode-absolute-paths.spec]]"
---

# MCP Absolute Directory Arguments Can Be Mistaken for Attachment Files

## Fact

OpenCode MCP argument preprocessing recursively resolves strings before `client.callTool()`. Absolute directory strings must be passed through unchanged; otherwise MCP tools that use directory paths as data fail before the MCP server receives the request.

## Context

The failure was discovered through `meta_use` calls to Octocode local tools with `queries[].path` set to `/Users/oleksii.honchar/www/misc/agent-meta-tool`.

## Impact

If `meta_use` or a direct MCP tool call fails with `Not a regular file` for an absolute directory, check `resolveAttachmentUris()` in `packages/opencode/src/mcp/index.ts` before blaming the target MCP server.

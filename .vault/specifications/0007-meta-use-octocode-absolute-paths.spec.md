---
type: spec
title: "Fix meta_use Octocode Absolute-Path Failures"
createdAt: "2026-07-10T15:35:00Z"
updatedAt: "2026-07-10T15:35:00Z"
tags: [mcp, octocode, meta-use, attachments]
kind: bugfix
status: completed
see_also:
  - "[[0033-absolute-directory-mcp-arguments.adr]]"
  - "[[0005-mcp-absolute-directory-argument-gotcha.memory]]"
---

# Fix meta_use Octocode Absolute-Path Failures

## Goal

Allow MCP tool calls, including `meta_use` delegation to Octocode local tools, to pass existing absolute directory paths without OpenCode converting them as attachment files.

## Scope

### In scope

- `packages/opencode/src/mcp/index.ts`
- `resolveAttachmentUris(args: unknown): unknown`
- `convertMcpTool()` forwarding behavior before `client.callTool()`
- Regression tests in `packages/opencode/src/mcp/resolve-attachments.test.ts`

### Out of scope

- Replacing `agent-meta-tool` delegation with a raw MCP client.
- Octocode-specific handling inside `agent-meta-tool`.
- Full nested schema rendering in `meta_search`.
- Changing absolute regular-file attachment conversion.

## Required Behavior

Given an MCP call with arguments like:

```json
{
  "queries": [
    {
      "pattern": "metaUse",
      "path": "/Users/oleksii.honchar/www/misc/agent-meta-tool",
      "mode": "discovery"
    }
  ]
}
```

OpenCode must pass the directory path through unchanged and must not raise `Not a regular file` before the MCP server receives the call.

## Verification

Verified in source:

- `packages/opencode/src/mcp/index.ts` checks `stat.isDirectory()` and returns the original string before file conversion.
- `packages/opencode/src/mcp/resolve-attachments.test.ts` includes nested `queries[].path` and converted MCP tool execution coverage.

Verified commands from session evidence:

```text
bun test src/mcp/resolve-attachments.test.ts
# 23 pass, 0 fail, 34 expect() calls

bun run typecheck
# passed
```

Live runtime evidence after patched OpenCode install/restart:

- `octocode_localSearchCode` succeeded with an absolute directory in `queries[].path`.
- `octocode_localFindFiles` succeeded with an absolute directory in `queries[].path`.
- `octocode_localViewStructure` succeeded with an absolute directory in `queries[].path`.
- `octocode_localGetFileContent` with a directory reached Octocode and returned an Octocode-level `fileReadFailed`, proving OpenCode preprocessing no longer blocked the request.

## Risks

- Existing absolute regular files are still converted to base64. A future MCP server that expects literal existing absolute file paths may need schema-aware conversion.
- Runtime success depends on the patched OpenCode build being installed and the process being restarted.

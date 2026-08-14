---
type: adr
id: ADR-0079
title: "Explicit tool_response_file Handling in MCP Tool Result Processing"
status: accepted
createdAt: "2026-08-14T09:35:00Z"
updatedAt: "2026-08-14T09:35:00Z"
tags: [mcp, tools, tool_response_file, session-processing]
supersedes: []
superseded_by: []
see_also: ["adrs/0054-inclusion-based-mcp-path-encoding.adr.md"]
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0079: Explicit tool_response_file Handling in MCP Tool Result Processing

## Context

When MCP tools (such as octocode) produce large outputs, they use the `tool_response_file` format to save results to a file on disk rather than inlining the content. The content item includes a `filePath` pointing to the saved file, along with metadata (fileName, fileSize, summary, savedAt, instructions).

Previously, better-opencode did not have explicit handling for this format. The corrupted `summary` field — which contains base64-encoded file content — was being used as if it were a file path, causing "Path name too long" errors.

Example error manifesting in practice:

```
{
  "type": "tool_response_file",
  "tool": "octocode_lspGetSemantics",
  "filePath": "/tmp/agent-tool-responses/octocode_lspGetSemantics-20260814-092527-e966ec8c.json",
  "fileSize": 159623,
  "summary": "\"[structuredContent]\\n{\\n  \\\"results\\\": [\\n    {\\n      \\\"id\\\": \\\"symbols-client\\\",\\n      \\\"status\\\": \\\"error\\\",\\n      \\\"data\\\": {\\n        \\\"error\\\": \\\"Path name too long: aW1wb3J0IHsKICBBZGFwdGVyRmFpbHVyZSw...",
}
```

## Decision

Add explicit handling for `tool_response_file` format in `session/tools.ts`:

1. Define the `ToolResponseFile` interface (lines 31-39)
2. Add `isToolResponseFile()` type guard (lines 45-57)
3. Extend `processContentItems()` to detect `tool_response_file` items and delegate to `buildToolResponseFileOutput()`
4. Read file content from `filePath` using `fs.readFileSync`, construct clean text output
5. Fall back to `instructions` field on file read failure (ENOENT, permission errors, etc.)

The fix is scoped to `session/tools.ts` — the MCP tool result processing layer — rather than the lower-level MCP transport.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Extend `mcp/index.ts` to handle file path resolution for outputs | Catches the issue at the MCP transport layer | Less direct; more complex integration with session processing | Rejected — `session/tools.ts` is the right layer for content-type-specific processing |
| Add generic file path resolution logic | Handles any future file-based formats | Less specific; potential for unintended side effects | Rejected — explicit handling per content type is more maintainable |
| Use `summary` field for file content | No file I/O needed | Summary is corrupted with base64-encoded content; unreliable | Rejected — not a viable data source |
| Add new field for file content | Clean separation | Requires changes to octocode and other MCP tools | Rejected — impractical for existing tool implementations |

## Consequences

- **Positive:** Large MCP tool outputs (159KB+ in reported cases) are now correctly processed, eliminating "Path name too long" errors
- **Positive:** Fallback to `instructions` on file read failure ensures graceful degradation
- **Positive:** `processContentItems()` is pure and testable with injectable `readFile` option
- **Negative:** File reading uses synchronous `fs.readFileSync` — acceptable for tool response processing (small number of calls, low latency impact) but worth noting
- **Neutral:** Follow-up opportunity: add file path validation (e.g., ensure path is absolute and within `/tmp/agent-tool-responses/`) — flagged as low-severity in review

## Related

- [[0054-inclusion-based-mcp-path-encoding.adr.md]] — ADR-0054 covers inclusion-based opt-in for MCP file path base64 encoding, which is related to the broader problem of file path handling in MCP tool I/O

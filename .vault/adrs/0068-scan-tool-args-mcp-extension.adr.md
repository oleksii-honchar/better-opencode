---
type: adr
id: ADR-0068
title: "Extend scanToolArgs to MCP Tool String Args"
status: accepted
createdAt: "2026-08-04T18:11:23Z"
updatedAt: "2026-08-04T18:11:23Z"
tags: [skill, dynamic-skills, mcp, tools]
supersedes: []
superseded_by: []
see_also:
  - "specifications/0013-dynamic-skill-loading-fix.spec.md"
  - "specifications/0011-dynamic-skill-discovery.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0068: Extend scanToolArgs to MCP Tool String Args

## Context

`scanToolArgs` handled only `read|write|edit|glob|grep|apply_patch`. MCP tools (e.g., `octocode_localSearchCode`) pass absolute paths in args and never triggered discovery.

## Decision

For unknown tools, scan string args with the same absolute-path regex used by `scanParts`. Prefer path-keyed args (`filePath`, `path`, `directory`, `dir`, `file`, `filename`) to bound false positives; fall back to scanning all string args only if keyed scan finds nothing.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Keep built-in-only | No false positives | Misses MCP-tool-driven mentions (octocode primary in this setup) | Rejected |
| Scan every arg regardless of key | Simpler | Higher false-positive rate | Rejected — path-keyed first |

## Consequences

- **Positive:** MCP tool mentions now trigger dynamic skill discovery.
- **Positive:** explicit built-in handlers retained.
- **Negative:** slightly more scanning work for unknown tools with absolute paths (bounded by parent-dir existence check).

## Verification

- Unknown-tool branch at `dynamic-scanner.ts:598-650` — ✅ verified

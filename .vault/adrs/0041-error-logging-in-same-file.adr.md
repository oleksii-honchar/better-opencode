---
type: adr
id: ADR-0041
title: "Error Logging in the Same File"
status: accepted
createdAt: "2026-07-12T19:47:00Z"
updatedAt: "2026-07-12T19:47:00Z"
tags: [logging, errors]
supersedes: []
superseded_by: []
see_also: ["adrs/0035-json-lines-format-for-tools-log.adr.md", "adrs/0039-single-post-execution-log-line.adr.md"]
---

# ADR-0041: Error Logging in the Same File

## Context

Errors include `InvalidArgumentsError` (schema validation) and execution failures (exceptions, MCP call errors).

## Decision

Errors are logged in `tools.log` as part of the same JSON line, using an `error: string` field.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Separate `tools-errors.log` | Separated concerns | Complicates correlation across files | Rejected — single file is simpler for debugging |

## Consequences

- **Positive:** Single file to grep for a tool call ID; consistent schema.
- **Positive:** `Effect.catchAll` captures the error before `orDie` swallows it.
- **Neutral:** `tools.log` may contain both success and error lines interleaved; filtering is done via `jq 'select(.error != null)'`.

---
type: adr
id: ADR-0095
title: "Preserve Fatal Log Entries via Log.flush()"
status: accepted
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [logging, cli, fatal-error, bugfix]
supersedes: []
superseded_by: []
see_also:
  - "specifications/0019-mcp-oauth-auth-reliability.spec.md"
---

# ADR-0095: Preserve Fatal Log Entries via Log.flush()

## Context

The top-level handler calls `Log.Default.error("fatal", data)` then `process.exit()` in `finally` — the async `stream.write` is killed before landing, so fatal entries are lost (verified: the 14:57 error log ends without an error entry). `process.exit()` cannot be removed — it exists to kill hanging docker MCP subprocesses (index.ts comment).

## Decision

Add `Log.flush(timeoutMs = 1000)` to `packages/core/src/util/log.ts` (tracks in-flight writes via `pendingWrites` + `drainWaiters` + timer fallback) and `await Log.flush()` in the index.ts catch block before the `finally`'s `process.exit()`. Verified in code: `flush()` at log.ts:105, `await Log.flush()` at src/index.ts:240.

## Alternatives Considered

Remove `process.exit()` — rejected: docker MCP subprocesses don't react to SIGTERM/SIGINT without `--init`; hang risk. Synchronous write for fatal — rejected: changes logging for all levels.

## Consequences

- Positive: fatal CLI errors are actually written to the log file (success criterion #3).
- Positive: only affects the fatal path; healthy paths unchanged.
- Neutral: 1s max delay on fatal exit.

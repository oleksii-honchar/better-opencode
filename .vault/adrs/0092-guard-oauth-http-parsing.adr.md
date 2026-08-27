---
type: adr
id: ADR-0092
title: "Guard OAuth HTTP Parsing at the Transport Boundary (guardedFetchFn)"
status: accepted
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [mcp, oauth, fetch-guard, sdk, bugfix]
supersedes: []
superseded_by: []
see_also:
  - "specifications/0019-mcp-oauth-auth-reliability.spec.md"
  - "concepts/0012-mcp-oauth-auth-flow.concept.md"
  - "memories/0021-ibkr-mcp-endpoint-behavior.memory.md"
---

# ADR-0092: Guard OAuth HTTP Parsing at the Transport Boundary (guardedFetchFn)

## Context

The MCP SDK auth chain (discovery/registration/token) calls `await response.json()` unguarded — in BOTH fork pin 1.27.1 and upstream 1.29.0. IBKR returns 401 with `content-length: 0` and serves metadata behind Akamai `no-store`; empty/truncated bodies throw JSC `JSON Parse error: Unrecognized token ''`, surfaced as opaque "Unexpected error". `StreamableHTTPClientTransport` forwards `fetchFn` into the SDK `auth()` chain in both SDK versions, so a transport wrapper covers every unguarded `.json()` call with zero SDK changes.

## Decision

Add `guardedFetchFn(serverUrl)` in `packages/opencode/src/mcp/fetch-guard.ts` wrapping global fetch: `!res.ok` (incl. 401), `204`, `text/event-stream` pass through untouched; `content-length: 0` on 2xx throws an empty-body error; only `application/json` 2xx bodies validated via `clone()` — empty/non-JSON becomes a descriptive error naming URL + status. Apply at the 3 `StreamableHTTPClientTransport` construction sites (`connectRemote` mcp/index.ts:509, `startAuth` mcp/index.ts:1084, `McpDebugCommand` cli/cmd/mcp.ts:782).

## Alternatives Considered

SDK upgrade to 1.29.0 — rejected: same unguarded calls (verified identical streamableHttp.js). Patch SDK via `patchedDependencies` — rejected: more invasive, breaks on version bump. Global fetch monkey-patch — rejected: too broad.

## Consequences

- Positive: fork's remote MCP handling no longer crashes on empty/non-JSON bodies; errors name URL + status.
- Positive: works on SDK 1.27.1 and 1.29.0 alike.
- Neutral: only `application/json` 2xx bodies read twice (clone) — negligible for metadata/registration payloads; SSE never touched.
- Risk: Response contract handling — mitigated by unit tests, 401 passthrough, SSE content-type guard (verified in code: fetch-guard.ts exists; 9 guard tests pass).

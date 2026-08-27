---
type: spec
title: "MCP OAuth Auth Reliability"
kind: bugfix
status: completed
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [mcp, oauth, cli, bugfix, fetch-guard]
see_also:
  - "adrs/0091-pin-mcp-remote-bridge.adr.md"
  - "adrs/0092-guard-oauth-http-parsing.adr.md"
  - "adrs/0093-bridge-guidance-instead-of-cli-integration.adr.md"
  - "adrs/0094-defer-sdk-129-upgrade.adr.md"
  - "adrs/0095-preserve-fatal-log-entries.adr.md"
  - "concepts/0012-mcp-oauth-auth-flow.concept.md"
---

# Spec: MCP OAuth Auth Reliability

## Goal

`opencode mcp auth ibkr-U20943171` either completes the OAuth flow OR fails with a clear, actionable error (no opaque "Unexpected error" + JSC `JSON.parse` message); the fork's remote MCP handling no longer crashes on empty/non-JSON response bodies; fatal CLI errors are actually written to the log file.

## Phases

1. **Phase 1 — Unblock the user (config):** pin `mcp-remote@0.2.6` in all user-config bridges.
2. **Phase 2 — Fork hardening:** `guardedFetchFn` in `mcp/fetch-guard.ts`, wrapped at 3 transport sites.
3. **Phase 3 — CLI usability:** bridge guidance (`isMcpRemoteBridge`/`printBridgeGuidance`) + registration error mapping.
4. **Phase 4 — Preserve fatal logs:** `Log.flush()` + `await Log.flush()` before `process.exit()`.
5. **Phase 5 (deferred):** SDK 1.29.0 upgrade — deferred per ADR-0094.

## Key Behaviors

- Guard order: `!res.ok`/204/SSE passthrough → `content-length: 0` throw → JSON clone-validate → other 2xx passthrough.
- Bridge guidance printed when `oauthServers() === 0` and local mcp-remote bridges detected.
- Registration error renders clientId hint; `Cause.squash` bypasses opaque "Unexpected error" path.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Guard breaks valid remote connects | MEDIUM | `clone()` + return original response; unit tests |
| Guard alters 401 OAuth trigger | MEDIUM | `!res.ok` passes through before any body read |
| mcp-remote 0.2.6 regresses bridges | MEDIUM | same-maintainer coordination-fix release; revert = change pin back |
| Log.flush delays/deadlocks exit | LOW | 1s timeout fallback; fatal path only |

**Status note:** All 5 phases implemented and verified by reviewer (41 targeted + 61 regression tests, 0 fail; typecheck clean). User-side step remains: rebuild binary via `build-and-install.sh`.

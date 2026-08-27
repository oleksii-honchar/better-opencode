---
type: adr
id: ADR-0093
title: "Bridge Guidance Instead of Full CLI Bridge Integration"
status: accepted
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [mcp, oauth, cli, bridge, mcp-remote]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0091-pin-mcp-remote-bridge.adr.md"
  - "runbooks/0002-mcp-bridge-reauthentication.runbook.md"
---

# ADR-0093: Bridge Guidance Instead of Full CLI Bridge Integration

## Context

`opencode mcp auth` only manages `type: "remote"` servers (upstream design, not a fork bug). The user runs all remote servers as `type: "local"` mcp-remote bridges (workaround for the `type: remote` dev-server "NUL byte" bug), so the CLI prints "No OAuth-capable MCP servers configured" — a no-op. Full integration (fork driving mcp-remote's own auth + per-version auth store layout) is complex and fragile.

## Decision

When `oauthServers()` is empty, `McpAuthCommand` detects local mcp-remote bridges (`type: "local"` + command contains `mcp-remote` + a URL arg, via `isMcpRemoteBridge`) and prints actionable guidance: run `npx --prefer-offline -y mcp-remote@0.2.6 <url>` directly, restart opencode. Advisory only. Implemented in `packages/opencode/src/cli/cmd/mcp.ts` (`isMcpRemoteBridge`, `mcpRemoteBridges`, `printBridgeGuidance`).

## Alternatives Considered

Fix the `type: remote` dev-server "NUL byte" bug so users revert to `type: remote` — rejected: pre-existing separate bug, out of scope, user constraint. Full bridge integration into `mcp auth` — rejected: scope creep, fragile per-version store handling.

## Consequences

- Positive: `opencode mcp auth ibkr-U20943171` now fails with a clear, actionable error instead of a bare no-op.
- Positive: zero risk to existing bridge behavior (advisory text only).
- Negative: does not automate the flow through the CLI; user still runs the bridge command manually.

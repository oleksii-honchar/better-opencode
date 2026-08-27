---
type: runbook
title: "Re-authenticate an mcp-remote MCP Bridge"
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [mcp, mcp-remote, oauth, bridge, runbook]
see_also:
  - "adrs/0091-pin-mcp-remote-bridge.adr.md"
  - "adrs/0093-bridge-guidance-instead-of-cli-integration.adr.md"
  - "memories/0020-mcp-remote-0201-signin-bugs.memory.md"
---

# Runbook: Re-authenticate an mcp-remote MCP Bridge

## Prerequisites

- OpenCode fork binary (better-opencode).
- Bridge configured as `type: "local"` mcp-remote in `~/.config/opencode/opencode.jsonc` (see memory 0022).
- Bridge pinned to `mcp-remote@0.2.6` or newer (see ADR-0091).

## Steps

1. Identify the bridge URL from `opencode.jsonc` (e.g., `https://api.ibkr.com/v1/api/mcp-public`).
2. Run the bridge directly:
   `npx --prefer-offline -y mcp-remote@0.2.6 <url>`
3. Complete the OAuth flow (discovery → registration → browser → authorize).
4. Restart opencode so the dev-server picks up the new bridge auth state.
5. If `opencode mcp auth <name>` was attempted first, note it prints bridge guidance when no `type: remote` OAuth servers exist — this is advisory, not a failure.

## Verification

- `npx mcp-remote@0.2.6 <url>` reaches discovery + registration and opens the browser (or completes silently with stored tokens).
- Bridge connects after opencode restart.

## Rollback

- Revert config pin to the previous mcp-remote version.
- Delete stale per-version auth stores under `~/.mcp-auth/mcp-remote-*` if torn state persists (4 resource IDs = stale state; see memory 0020).

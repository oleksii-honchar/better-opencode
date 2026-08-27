---
type: memory
title: "type: remote MCP Servers Break (NUL byte) — Use local mcp-remote Bridges"
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-27T17:04:04Z"
tags: [mcp, mcp-remote, bridge, workaround, gotcha]
see_also:
  - "adrs/0093-bridge-guidance-instead-of-cli-integration.adr.md"
  - "adrs/0096-defect-safe-readjson.adr.md"
  - "runbooks/0002-mcp-bridge-reauthentication.runbook.md"
---

# type: remote MCP Servers Break (NUL byte) — Use local mcp-remote Bridges

## Fact

In the better-opencode fork, `"type": "remote"` URL-based MCP servers break with "JSON Parse error: NUL byte" (dev-server in-process HTTP transport bug). The workaround: configure all remote servers as `"type": "local"` mcp-remote stdio bridges. Side effect: `opencode mcp auth` becomes a no-op for these servers because it only lists `type: remote` servers (upstream design).

## Context

Documented in a config comment on `bensyne`; the user converted ALL remote servers (ibkr, notion, kagi, atlassian, copilot, payfit, …) to local mcp-remote bridges. 13 bridges pinned `mcp-remote@0.2.6` as of 2026-08-26.

## Impact

If a remote MCP server fails with "JSON Parse error: NUL byte", it's the dev-server transport bug — bridge it via mcp-remote instead of fighting the fork. Use `opencode mcp auth` guidance (ADR-0093) or the re-auth runbook to manage bridge OAuth.

## Status (2026-08-27 — Round 2 fix, ADR-0096)

The NUL-byte crash class is **code-fixed in the fork** by
`ADR-0096` (`packages/core/src/filesystem.ts` `Effect.try` wrap +
`packages/opencode/src/mcp/auth.ts` guarded warning) — a corrupt
`mcp-auth.json` no longer kills the process; it degrades to "servers need
re-auth" with a visible warning, and the process survives. The earlier
local-mcp-remote bridge workaround was a mitigation for this bug class
and remains governed by the mcpurl / `ADR-0091` track (cleanup is a
separate follow-up track, **not done** in this round).

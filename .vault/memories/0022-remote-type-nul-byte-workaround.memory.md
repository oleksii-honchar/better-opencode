---
type: memory
title: "type: remote MCP Servers Break (NUL byte) — Use local mcp-remote Bridges"
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [mcp, mcp-remote, bridge, workaround, gotcha]
see_also:
  - "adrs/0093-bridge-guidance-instead-of-cli-integration.adr.md"
  - "runbooks/0002-mcp-bridge-reauthentication.runbook.md"
---

# type: remote MCP Servers Break (NUL byte) — Use local mcp-remote Bridges

## Fact

In the better-opencode fork, `"type": "remote"` URL-based MCP servers break with "JSON Parse error: NUL byte" (dev-server in-process HTTP transport bug). The workaround: configure all remote servers as `"type": "local"` mcp-remote stdio bridges. Side effect: `opencode mcp auth` becomes a no-op for these servers because it only lists `type: remote` servers (upstream design).

## Context

Documented in a config comment on `bensyne`; the user converted ALL remote servers (ibkr, notion, kagi, atlassian, copilot, payfit, …) to local mcp-remote bridges. 13 bridges pinned `mcp-remote@0.2.6` as of 2026-08-26.

## Impact

If a remote MCP server fails with "JSON Parse error: NUL byte", it's the dev-server transport bug — bridge it via mcp-remote instead of fighting the fork. Use `opencode mcp auth` guidance (ADR-0093) or the re-auth runbook to manage bridge OAuth.

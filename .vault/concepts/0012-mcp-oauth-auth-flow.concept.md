---
type: concept
title: "MCP OAuth Auth Flow in better-opencode"
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [mcp, oauth, sdk, cli, architecture]
see_also:
  - "adrs/0092-guard-oauth-http-parsing.adr.md"
  - "adrs/0093-bridge-guidance-instead-of-cli-integration.adr.md"
  - "specifications/0019-mcp-oauth-auth-reliability.spec.md"
---

# Concept: MCP OAuth Auth Flow in better-opencode

## What

The MCP OAuth auth flow is the chain that authenticates a remote MCP server: `opencode mcp auth NAME` → `McpAuthCommand` (cli/cmd/mcp.ts) → lists `oauthServers()` (type remote only) → `MCP.authenticate`/`startAuth` (mcp/index.ts) constructs a `StreamableHTTPClientTransport` → SDK auth chain (discover protected-resource metadata → discover authorization-server metadata → dynamic registration → /authorize → browser → callback → token exchange). Transport construction wraps global fetch via `guardedFetchFn` at 3 sites (connectRemote, startAuth, McpDebugCommand).

## Why

Understanding the auth flow explains why errors surface as opaque "Unexpected error": the SDK's unguarded `await response.json()` throws JSC `JSON Parse error: Unrecognized token ''` on empty bodies, and failures before `startAuth`'s connect step bubble to the top-level catch-all. `mcp auth` is a no-op for `type: local` mcp-remote bridges by design (upstream).

## Key Details

- `oauthServers()` selects only `type: "remote"` servers with `oauth !== false` — the CLI cannot manage local bridges.
- SDK pins: fork 1.27.1, upstream 1.29.0 — both have identical unguarded `.json()` calls in streamableHttp.js/auth.js.
- `guardedFetchFn` wrapper covers every SDK `.json()` call with zero SDK changes.
- 401 with `content-length: 0` is the OAuth trigger — SDK reads `www-authenticate`, never the body.

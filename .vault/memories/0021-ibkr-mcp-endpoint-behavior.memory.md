---
type: memory
title: "IBKR MCP Endpoint Behavior — 401 Empty Body, Akamai no-store, Registration Works"
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [ibkr, mcp, oauth, endpoints, gotcha]
see_also:
  - "adrs/0092-guard-oauth-http-parsing.adr.md"
  - "concepts/0012-mcp-oauth-auth-flow.concept.md"
---

# IBKR MCP Endpoint Behavior — 401 Empty Body, Akamai no-store, Registration Works

## Fact

IBKR's MCP endpoint (`https://api.ibkr.com/v1/api/mcp-public`) returns HTTP 401 with `content-length: 0` (empty body) plus `www-authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"`. Discovery metadata is served behind Akamai `cache-control: no-store` / `cdn-cache: MISS` and can transiently return empty/truncated 200s. Dynamic registration works at `POST https://api.ibkr.com/oauth2/register` → 201 valid JSON.

## Context

Verified live 2026-08-26 (findings F7/F12). The 401 empty body + transient empty 200s hit unguarded `.json()` calls in the MCP SDK auth chain → JSC `JSON Parse error: Unrecognized token ''`.

## Impact

Any unguarded `response.json()` in an OAuth/MCP client will crash against IBKR on transient empty bodies. Guard the fetch boundary (see ADR-0092). Registration DOES work — an "Incompatible auth server" error means the SDK metadata path lacks `registration_endpoint`, not that registration is impossible.

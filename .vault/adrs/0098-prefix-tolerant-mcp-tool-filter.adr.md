---
type: adr
id: ADR-0098
title: "Prefix-Tolerant MCP enabledTools / disabledTools Matching (regex)"
status: accepted
createdAt: "2026-08-30T15:47:00Z"
updatedAt: "2026-08-30T15:47:00Z"
tags: [mcp, tool-filter, enabledTools, litellm, regex]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0091-pin-mcp-remote-bridge.adr.md"
  - "adrs/0092-guard-oauth-http-parsing.adr.md"
  - "memories/0023-litellm-mcp-tool-name-prefixing.memory.md"
  - "concepts/0005-agent-meta-tool-plugin.concept.md"
  - "concepts/0012-mcp-oauth-auth-flow.concept.md"
---

# ADR-0098: Prefix-Tolerant MCP enabledTools / disabledTools Matching (regex)

## Context

opencode's MCP filter (`packages/opencode/src/mcp/index.ts` L903-906) matched
`enabledTools`/`disabledTools` entries against server-returned tool names with
**exact string inclusion** (`toolFilter.includes(mcpTool.name)`).

LiteLLM proxies (`https://lite-llm.lan/mcp/<server>`) prefix every tool name
with `<server>-` (e.g., `bensyne-recallMemory`). When bensyne moved from direct
`localhost:3000` to LiteLLM, the unprefixed allowlist in `opencode.jsonc`
matched nothing — all 16 tools excluded (`excludedToolCount=16`),
`meta_search("bensyne")` returned empty.

Config edits to add prefixes would fix bensyne once, but the mismatch recurs
every time a server is re-proxied or renamed.

## Decision

Introduce a prefix-tolerant matcher in the fork:

- **New module** `packages/opencode/src/mcp/tool-name-filter.ts` exports
  `toolNameMatches(toolName, names)`.
- **Semantics**: entry `P` matches tool `T` iff `T === P` (exact,
  backward-compatible) **or** `T` equals `P` preceded by any non-empty prefix
  terminated by one of `-`, `_`, `.`.
- **Implementation**: per-entry regex `^(?:.*[._-])?P_escaped$` cached in a
  module-level `Map<string, RegExp>`; metacharacters escaped via `escapeRegExp`.
- **Application**: replaces `toolFilter.includes(...)` for both `enabledTools`
  (whitelist) and `disabledTools` (blacklist) in `mcp/index.ts`.
- **Per-server scoping**: each server's returned names are tested only against
  that server's own list — no cross-server over-matching.
- **No config change**: `opencode.jsonc` stays untouched — unprefixed bensyne
  allowlist works as-is; the `// "forgetFile" is intentionally OMITTED` safety
  guard is preserved.

Committed as `1303e339ea` on `patched/dev2`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Edit `opencode.jsonc` to prefixed names | Fixes current server | Brittle: breaks on every re-proxy/rename | User directed mechanism fix over config patch |
| Strict `{serverKey}-{name}` matching | Precise scoping | Fails when config key ≠ LiteLLM path name | User asked for any prefix tolerance |
| Wildcard patterns in config | Flexible | Schema change, complexity | Overkill for this problem |
| Case-insensitive / substring matching | Simple | Over-permissive, false-positive risk | Real over-matching concern |

## Consequences

- **Positive**: Unprefixed AND prefixed allowlist entries both work — bensyne
  config (unprefixed) and paperless/mermaid/kagi (prefixed) are correct with
  zero config edits.
- **Positive**: Future LiteLLM re-prefixing cannot silently empty a server
  again; the dev.log `excludedToolCount` warn remains as a tripwire.
- **Accepted trade-off**: An unprefixed entry matches any separator-terminated
  prefix on that same server — bounded by per-server scoping, intentional per
  "allow any prefix".
- **Consistent blacklist**: A blacklisted base name now also disables its
  prefixed variants (intentional, consistent behavior).
- **Operational**: Fork change on `patched/dev2`; 15/15 unit tests;
  `bun turbo typecheck` 15/15; build-and-install verified live.

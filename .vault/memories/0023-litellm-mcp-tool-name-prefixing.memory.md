---
type: memory
title: "LiteLLM-Proxy MCP Tool Names Get <server>- Prefix; Unprefixed Allowlists Silently Break"
createdAt: "2026-08-30T15:54:00Z"
updatedAt: "2026-08-30T15:54:00Z"
tags: [mcp, litellm, gotcha, enabledTools, meta-search, debugging]
see_also:
  - "adrs/0098-prefix-tolerant-mcp-tool-filter.adr.md"
  - "memories/0022-remote-type-nul-byte-workaround.memory.md"
  - "concepts/0005-agent-meta-tool-plugin.concept.md"
---

# LiteLLM-Proxy MCP Tool Names Get <server>- Prefix; Unprefixed Allowlists Silently Break

## Fact

When an MCP server is accessed via a LiteLLM proxy
(`https://lite-llm.lan/mcp/<server>`), LiteLLM prefixes every tool with
`<server>-`. Unprefixed `enabledTools` entries in `opencode.jsonc` fail to match
these prefixed names — all tools from that server are silently excluded by
opencode's MCP filter — and `meta_search` returns empty for that server.

## Context

Discovered in session `260830-1518-bensyne-meta-tool` (2026-08-30): bensyne
moved from direct `localhost:3000` to LiteLLM; all 16 tools excluded
(`excludedToolCount=16` in dev.log); `meta_search("bensyne")` empty. Fixed by
ADR-0098 (prefix-tolerant regex matcher in the fork).

## Impact

If `meta_search` returns nothing for a LiteLLM-proxied server:
1. Check dev.log for `WARN service=mcp clientName=<name> filter=enabledTools excludedToolCount=N`
2. Compare `expectedToolNames` (from config) vs `receivedToolNames` (from server) — prefix mismatch is the root cause
3. ADR-0098 makes this a non-issue for future server moves via LiteLLM

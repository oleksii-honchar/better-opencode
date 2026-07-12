---
type: adr
id: ADR-0036
title: "Unified toolsLog Helper Called from Both tool.ts and session/tools.ts"
status: accepted
createdAt: "2026-07-12T19:47:00Z"
updatedAt: "2026-07-12T19:47:00Z"
tags: [logging, architecture]
supersedes: []
superseded_by: []
see_also: ["adrs/0034-log-helper-lives-in-core.adr.md", "adrs/0035-json-lines-format-for-tools-log.adr.md"]
---

# ADR-0036: Unified toolsLog Helper Called from Both tool.ts and session/tools.ts

## Context

Built-in tools pass through `tool.ts` `wrap()`; MCP tools are wrapped directly in `session/tools.ts`. We need consistent logging for both.

## Decision

Introduce a shared `Log.toolsLog()` helper and call it from:
- `packages/opencode/src/tool/tool.ts` `wrap()` — for built-in tools.
- `packages/opencode/src/session/tools.ts` — for MCP tools.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Log only in `session/tools.ts` | Single call site | Can't capture decoded args or pre-truncation results from `tool.ts` | Rejected — loses data available at `wrap()` layer |
| Log only in `tool.ts` | Captures decoded args | MCP tools bypass `tool.ts` entirely | Rejected — incomplete coverage |

## Consequences

- **Positive:** Single formatting logic, DRY; easy to change gating or schema in one place.
- **Positive:** Each call site captures the data naturally available at that layer.
- **Neutral:** Two files instrumented instead of one.
- **Neutral:** Both must agree on the JSON schema passed to `toolsLog`.

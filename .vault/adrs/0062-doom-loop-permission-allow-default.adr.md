---
type: adr
id: ADR-0062
title: "Change Default doom_loop Permission to allow"
status: accepted
createdAt: "2026-08-01T13:22:43Z"
updatedAt: "2026-08-01T13:22:43Z"
tags: [unstuck, doom-loop, permission, config]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0060-allow-then-catch-doom-loop.adr.md"
  - "adrs/0064-doom-loop-config-migration.adr.md"
  - "specifications/0012-doom-loop-nudge.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0062: Change Default doom_loop Permission to allow

## Context

The permission default lived in `agent/agent.ts:126` (`doom_loop: "ask"`). The user's effective ruleset included both the `ask` default and an explicit `deny` from their custom agent configs.

## Decision

Change the shared default to `doom_loop: "allow"`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Leave default `ask` | Preserves prompting | Still prompts (not errors) for default users; defeats the "automatic nudge" intent | Rejected |
| Override user `deny` in code | Forces behavior | Violates user-config-wins precedence | Rejected |

## Consequences

- **Positive:** enables the Allow-then-Catch flow for default users; `"allow"` at the default layer is safe — unstuck (enabled by default) now owns loop recovery; a tool call still executes (never silently blocked/errored); normal per-tool permission checks (`session/tools.ts`) are unaffected.
- **Negative (caveat HIGH):** explicit `deny` rules in user configs override the default. This user's agents all set `doom_loop: deny`; config migration (ADR-0064) is required for their environment.
- **Neutral:** behavior change for users relying on the doom_loop `ask` prompt — mitigated by config escape hatch.

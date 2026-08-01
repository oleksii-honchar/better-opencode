---
type: adr
id: ADR-0064
title: "Config Migration is Part of the Deliverable (User Environment)"
status: accepted
createdAt: "2026-08-01T13:22:43Z"
updatedAt: "2026-08-01T13:22:43Z"
tags: [unstuck, doom-loop, config, migration, agents]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0060-allow-then-catch-doom-loop.adr.md"
  - "adrs/0062-doom-loop-permission-allow-default.adr.md"
  - "specifications/0012-doom-loop-nudge.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0064: Config Migration is Part of the Deliverable (User Environment)

## Context

The user's doom_loop failures came from `doom_loop: deny` in their custom agent files, which override the new default. The **source of truth** for those agent files is `~/Documents/agent-rules-n-skills/agents/` — both `opencode/` (8 agents) and `caveman-opencode/` (10 agents, incl. super-*) carried `doom_loop: deny`. The deployed copy at `~/.config/opencode/agents/*.md` is derived from that source.

## Decision

Deliverable includes **removing the `doom_loop` keys** from the **source** agent files in `~/Documents/agent-rules-n-skills/agents/opencode/*.md` and `~/Documents/agent-rules-n-skills/agents/caveman-opencode/*.md`, then redeploying to `~/.config/opencode/agents/*.md`. This is environment config, not repo code. (Removal, not `deny`→`allow`, because the new default is `allow` — no explicit rule needed.)

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Leave explicit `deny` in configs | No user action | Raw DeniedError persists despite code change | Rejected |
| Set `doom_loop: allow` explicitly in configs | Explicit | Dead/duplicated config once the default changes; redundant | Rejected — removal is cleaner |
| Add processor-level DeniedError safety net | Handles deny without migration | Second recovery owner; layers complexity | Rejected (2026-08-01 decision) — config migration is the sole path for explicit deny users |

## Consequences

- **Positive:** the user's reported symptom (raw DeniedError) is eliminated; respects user-config-wins precedence; editing the source keeps the single source of truth in sync and survives redeploys.
- **Negative:** requires human action (source edit + redeploy) to fully realize the fix in the user's environment.

---
type: decision
id: DEC-0110
title: "Cap Consecutive Compaction Auto-Continues at 3"
status: proposed
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [compaction, autocontinue, incident, 2026-10-03]
system: opencode
supersedes: []
superseded_by: []
see_also:
  - "0109-capped-post-compaction-re-anchor.adr.md"
  - "../specifications/0024-runaway-loop-hardening.spec.md"
---

# DEC-0110: Cap Consecutive Compaction Auto-Continues at 3

> **Status note:** implemented on branch `261003-fix-runaway-loop-hardening` (staged,
> not yet committed/merged as of 2026-10-04). Flip to `accepted` after merge.

## Context

`experimental.compaction.autocontinue` (default enabled, `compaction.ts:640-690`)
injects "Continue if you have next steps" synthetic messages — the runaway loop's
fuel between compactions.

## Decision

Count consecutive preceding `compaction_continue`-marked messages (walk
`input.messages` backwards, `MAX_CONSECUTIVE_AUTOCONTINUES = 3` in
`compaction.ts`); at ≥3 suppress the injection and log
`log.warn("auto-continue cap reached — stopping")`. Real user messages break the
chain (walk stops at first non-marker message).

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| Disable autocontinue globally | Breaks legitimate long tasks |
| Time-based throttle | The loop was fast; count is the precise signal |

## Consequences

- Runaway sessions self-stop without human intervention.
- Behavioral change visible in logs for support.
- Chain-break semantics follow the architect's DEC-3 (real user messages reset the
  count), which the reviewer accepted over the spec's literal walk.

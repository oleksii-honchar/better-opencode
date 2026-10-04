---
type: decision
id: DEC-0111
title: "Immutable Original Task + Goal-Drift Tripwire in Compaction"
status: proposed
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [compaction, goal-integrity, confabulation, incident, 2026-10-03]
system: opencode
supersedes: []
superseded_by: []
see_also:
  - "../memories/0029-confabulated-goal-laundered-by-compaction.memory.md"
  - "../specifications/0024-runaway-loop-hardening.spec.md"
  - "0109-capped-post-compaction-re-anchor.adr.md"
---

# DEC-0111: Immutable Original Task + Goal-Drift Tripwire

> **Status note:** implemented on branch `261003-fix-runaway-loop-hardening` (staged,
> not yet committed/merged as of 2026-10-04). Flip to `accepted` after merge.

## Context

The 2026-10-03 incident's anchored-summary loop laundered a confabulated goal
("Short Engine / XDR alignment contract", zero grounding) into every later pass as
a user message; nothing pinned the real task.

## Decision

Add `## Original Task (immutable)` to SUMMARY_TEMPLATE, seeded verbatim (≤2000
chars, U+2026 truncation) from the first non-synthetic user message; the summarizer
must copy it unchanged; Goal must follow Original Task on conflict. Add a
goal-drift tripwire: normalized `## Goal` diff between successive summaries with no
intervening real user message → `log.warn` + `metadata.goal_drift` on the summary
message (`message-v2.ts` Assistant schema gained an optional `metadata` field —
backward-compatible).

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| Grounding validation of goal against history entities | Rejected for v1 — heavy, false positives |
| Blocking compaction on drift | Availability risk |
| Do nothing | E11-class incident recurs |

## Consequences

- Goal hijack becomes visible and bounded.
- `SUMMARY_TEMPLATE` is upstream-derived (`574b2c217`, #23870) and `message-v2.ts`
  schema is also touched — two upstream-derived touchpoints widen the
  rebase-conflict surface; resolve at next upstream sync per governance rules.
- Template change affects all future summaries (minor context cost, spec-bounded).

---
type: adr
id: ADR-0006
title: "Tool Output Deletion on Age, Not Session Status"
status: accepted
createdAt: "2026-06-10T14:30:00Z"
updatedAt: "2026-06-10T14:30:00Z"
tags: [database, data-lifecycle, compaction, performance]
see_also:
  - "adrs/0002-hybrid-cli-background.adr.md"
  - "adrs/0003-existing-time-archived-cascade.adr.md"
  - "memories/0001-part-table-dominance.memory.md"
  - "concepts/0001-session-model.concept.md"
  - "specifications/0001-opencode-db-cleanup.spec.md"
---

# ADR-0006: Tool Output Deletion on Age, Not Session Status

## Context

`opencode db compact` needs to decide what tool outputs to delete. Options: (a) delete only compacted parts, (b) delete all tool outputs from sessions older than N days, (c) both.

## Decision

Delete **compacted parts** (any age) + **all tool call parts** from sessions older than the threshold (default 90 days).

## Rationale

- Compacted parts are already summarized — keeping their raw output is wasteful
- Old session tool outputs are unlikely to be reviewed after 90 days
- Keeps recent sessions pristine (data available for review/resume)
- User can override with `--older-than`

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Delete only compacted parts | Conservative, safe | Misses 91% of un-compacted old tool outputs | Not aggressive enough |
| Delete all old tool outputs (regardless of compacted status) | Maximum space recovery | Could delete recent outputs if threshold is wrong | Combined approach is best |

## Consequences

- **Positive:** Maximum space recovery (514MB of tool outputs is the primary target)
- **Positive:** Recent sessions unaffected
- **Negative:** User loses ability to inspect old tool outputs after cleanup

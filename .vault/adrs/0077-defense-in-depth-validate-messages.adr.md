---
type: adr
id: ADR-0077
title: "Add Defense-in-Depth in LLM.validateMessages for Orphan Tool-Results"
status: accepted
createdAt: "2026-08-13T10:35:00Z"
updatedAt: "2026-08-13T10:35:00Z"
tags: [tool-calls, validation, defense-in-depth]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0075-fix-at-assembly-layer.adr.md"
  - "adrs/0076-drop-orphan-tool-results.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0077: Add Defense-in-Depth in LLM.validateMessages for Orphan Tool-Results

## Context

The preserve layer in `MessageV2.toModelMessagesEffect` is the primary fix for orphaned tool-results. But the same orphan class of bug could re-emerge from:

- A future change to `convertToModelMessages` (AI SDK upgrade).
- A new provider adapter that bypasses `toModelMessagesEffect`.
- Session-resume from DB corruption.

`LLM.validateMessages` is the existing chokepoint between assembly and the LLM adapter; extending it costs little and catches everything the preserve layer misses.

## Decision

Extend `LLM.validateMessages` to detect and drop orphan tool-results, but never fail the request on this condition.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Extend validateMessages | Cheap insurance; consistent with existing pattern | Minor overlap with preserve layer | — |
| Rely solely on preserve layer | Simpler | Single point of failure; AI SDK upgrades could re-introduce the bug | Insufficient |
| Fail the request on orphan | User is informed | Disruptive; hard session failure | Worse for the user |

## Consequences

- **Positive:** Two layers of repair run before any provider adapter sees the messages.
- **Positive:** The OpenAI Responses adapter's existing `repairOrphanedInputItems` is now the third layer — kept in place as defense-in-depth.
- **Positive:** Any future regression in the assembly path is caught at the LLM boundary with a warning log.
- **Neutral:** `findOrphanedToolResults` (llm.ts) and `repairOrphanedToolResults` (message-v2.ts) share overlapping Set-collection logic (~30 LOC). Potential future DRY refactor target.

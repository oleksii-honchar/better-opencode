---
type: adr
id: ADR-0063
title: "No Processor Change for the Nudge Path"
status: accepted
createdAt: "2026-08-01T13:22:43Z"
updatedAt: "2026-08-01T13:22:43Z"
tags: [unstuck, doom-loop, processor, session]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0060-allow-then-catch-doom-loop.adr.md"
  - "specifications/0012-doom-loop-nudge.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0063: No Processor Change for the Nudge Path

## Context

The processor's doom_loop check (`processor.ts:424-448`) fires on the `tool-call` event; unstuck sees `tool-input-end` chunks earlier in the stream.

## Decision

Keep `session/processor.ts` unchanged for the nudge path. Interception happens at the stream level before the processor's doom_loop check fires.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Catch DeniedError in processor.ts (safety net) | Handles explicit deny rules | Adds a second recovery path; layering complexity | Rejected — see ADR-0064 (config migration is the sole path) |

## Consequences

- **Positive:** detection timing verified — unstuck consumes `tool-input-end` before the processor handles the corresponding `tool-call` → the nudge fires first; `DOOM_LOOP_THRESHOLD` stays as the fallback guard (now resolving to `allow`); minimizes blast radius — no change to session message-part lifecycle or permission handling.
- **Negative:** if unstuck is disabled or misses the pattern, no nudge fires (but no raw error for default users — the call is allowed).
- **Neutral:** interrupted tool parts from a mid-stream nudge restart are handled by existing `cleanup` ("Tool execution aborted").

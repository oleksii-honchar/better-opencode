---
type: adr
title: "Stop Clearing Detector History on Clean Stream Completion"
id: 1
status: accepted
createdAt: "2026-06-21T00:00:00Z"
tags: [unstuck, loop-detection, detector]
see_also:
  - "0017-tool-detection-gap-tolerance.adr.md"
  - "0020-detector-state-sharing.adr.md"
  - "../concepts/0007-unstuck-loop-detection.concept.md"
---

# ADR-0016: Stop Clearing Detector History on Clean Stream Completion

**ADR ID:** ADR-1
**Status:** accepted
**Date:** 2026-06-21

## Context

The unstuck plugin's `wrapper.ts` calls `detector.clear()` on every clean stream completion (line 222 in original). This destroys the step history after every LLM call stream, preventing detection of loops that span multiple streams. Each loop iteration produces exactly 1 step per stream (1 finish chunk), so history is erased → next stream starts fresh → tool-only detection needs 6 consecutive steps → impossible if history resets after each step.

## Decision

Remove `detector.clear()` from the clean-completion path in `wrapper.ts`. Keep `evidence.clear()` (evidence is per-episode) and keep `detector.clear()` on nudge intervention (line 338 in implemented code).

## Alternatives Considered

1. Keep clear but add a separate cross-stream accumulator — too complex
2. Only clear when a threshold is met (restart after nudge) — already happens at nudge intervention
3. No change — accept the bug — rejected (697+ iterations is clearly broken)

## Consequences

- **Positive:** Tool-only detection starts working across streams (detects after 6 iterations)
- **Positive:** Minimal code change (1 line removal)
- **Risk:** History could grow across unrelated conversations — mitigated by `historySize: 10`
- **Risk:** Cross-thread contamination — mitigated by sandbox semantics (ADR-0020)

## Verification

✅ Confirmed in `wrapper.ts:226-229` — `detector.clear()` removed, `evidence.clear()` preserved. `detector.clear()` on nudge at line 338 preserved.

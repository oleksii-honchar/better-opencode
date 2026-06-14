---
type: adr
title: "Add Period-2 Alternating Pattern Detection"
id: 3
status: accepted
createdAt: "2026-06-21T00:00:00Z"
tags: [unstuck, loop-detection, pattern-detection]
see_also:
  - "0016-clear-detector-history.adr.md"
  - "0017-tool-detection-gap-tolerance.adr.md"
---

# ADR-0018: Add Period-2 Alternating Pattern Detection

**ADR ID:** ADR-3
**Status:** accepted
**Date:** 2026-06-21

## Context

The detector has no mechanism to recognize A→B→A→B (or higher-period) alternating patterns. The model can alternate between two distinct step types indefinitely without triggering any existing detector. The observed 697-iteration loop has exactly this pattern.

## Decision

Add a new `pattern_loop` detection type that checks for period-2 alternating patterns in the step fingerprint sequence. Require exactly 2 distinct fingerprints alternating consistently for a minimum of 4 steps (2 full cycles). Fingerprint-based pattern detection for precision.

## Alternatives Considered

1. General period detection (any period P) — over-engineering, period-2 covers the observed case
2. Tool-signature-only pattern detection — less precise (cannot distinguish different thinking patterns)
3. Statistical anomaly detection — too complex, too many tuning parameters

## Consequences

- **Positive:** Directly detects the A→B→A→B pattern
- **Positive:** Precise detection via fingerprint matching (low false positive rate)
- **Risk:** Might miss higher-period patterns (P > 2) — can be extended later if needed
- **Risk:** Requires `patternLoopThreshold` tuning — start at 4

## Verification

✅ Confirmed in `loop-detector.ts:343-380` — checks exactly 2 distinct fingerprints with `i % 2` alternation verification, returns compound fingerprint `${evenFp}|${oddFp}`. Config: `patternLoopThreshold: 4` in `config.ts`.

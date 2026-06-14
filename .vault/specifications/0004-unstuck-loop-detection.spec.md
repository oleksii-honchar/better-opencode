---
type: specification
title: "Unstuck Loop Detection Improvements"
kind: feature
status: completed
createdAt: "2026-06-21T00:00:00Z"
tags: [unstuck, loop-detection, better-opencode]
see_also:
  - "../adrs/0016-clear-detector-history.adr.md"
  - "../adrs/0017-tool-detection-gap-tolerance.adr.md"
  - "../adrs/0018-alternating-pattern-detection.adr.md"
  - "../adrs/0019-self-diagnosis-detection.adr.md"
  - "../concepts/0007-unstuck-loop-detection.concept.md"
---

# SPEC-0004: Unstuck Loop Detection Improvements

**Kind:** feature
**Status:** completed
**Date:** 2026-06-21

## Goal

Fix unstuck plugin cross-stream loop detection and add new detection mechanisms to catch loops that bypass the current fingerprint-based system.

## Scope

1. **better-opencode fork** — Fix unstuck plugin cross-stream loop detection + add 3 new detection mechanisms
2. **agent-persona-coach** — Add agent self-reflection for behavioral loops

## Phases

- **Phase 1 (P0):** Remove `detector.clear()` from clean-completion path — cross-stream history preservation
- **Phase 2 (P1):** Add `detectSelfDiagnosis()` — model self-awareness detection with immediate intervention
- **Phase 3 (P2):** Add tool-only detection with gap tolerance + period-2 alternating pattern detection

## Implementation Status

✅ All 3 phases implemented. 88 tests passing, 0 failures. Verified against codebase.

## Files Modified

- `packages/opencode/src/plugin/unstuck/wrapper.ts` — P0 fix + self-diagnosis integration + pattern_loop nudge message
- `packages/opencode/src/plugin/unstuck/loop-detector.ts` — self-diagnosis + tool-with-gaps + alternating pattern
- `packages/opencode/src/plugin/unstuck/error.ts` — type union extensions (5 detection types)
- `packages/opencode/src/plugin/unstuck/config.ts` — new config fields + default evidence thresholds
- `src/types.ts` (agent-persona-coach) — loop reflection prompt additions

## New Detection Types

`step_loop` (existing), `tool_loop` (existing), `sentence_loop` (existing), `self_diagnosis_loop` (new), `pattern_loop` (new)

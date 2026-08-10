---
type: specification
title: "Fix False self_diagnosis_loop Triggers in Unstuck Loop Detector"
kind: feature
status: completed
createdAt: "2026-08-10T18:45:00Z"
updatedAt: "2026-08-10T18:45:00Z"
tags: [unstuck, loop-detection, self-diagnosis, lifecycle]
see_also:
  - "adrs/0072-per-stream-loop-detector.adr.md"
  - "adrs/0073-self-diagnosis-threshold-2.adr.md"
  - "concepts/0007-unstuck-loop-detection.concept.md"
---

# SPEC-0015: Fix False self_diagnosis_loop Triggers in Unstuck Loop Detector

**Kind:** feature
**Status:** completed

## Goal

Eliminate false `self_diagnosis_loop` triggers for normal messages in any chat while preserving real loop detection.

## Solution

Two interacting fixes:

1. **Per-stream detector isolation (ADR-0072)** — `LoopDetectorImpl` instantiation moved from `getLanguage` (global, once per model) to inside `doStream` (local, once per call). Eliminates cross-session leakage of history, streaming state, evidence, and nudgeCount. Removes the fragile `lastUserMessageCount` reset logic (wrapper.ts:242-252).
2. **Self-diagnosis threshold 2 (ADR-0073)** — `evidenceThresholds.selfDiagnosis: 2` in `defaultEvidenceThresholds` (config.ts). One natural-language phrase no longer triggers intervention.

## Phases

- **Phase 1:** Core isolation — provider.ts removes detector creation; wrapper.ts creates per-stream detector; reset logic deleted; index.ts export updated.
- **Phase 2:** Self-diagnosis refinement — threshold raised to 2 (per ADR-0073; spec.md §5 originally suggested 3 — superseded by decision record).
- **Phase 3:** Cleanup — `detector.clear()`/`evidence.clear()` retained on nudge path (nudge restarts the SAME doStream); verified retained.

## Files Modified

- `packages/opencode/src/plugin/unstuck/provider.ts`
- `packages/opencode/src/plugin/unstuck/wrapper.ts`
- `packages/opencode/src/plugin/unstuck/config.ts`
- `packages/opencode/src/plugin/unstuck/index.ts`
- Tests: `wrapper.test.ts`, `wrapper-per-stream.test.ts` (new), `doom-loop.integration.test.ts`, `loop-detector.test.ts`

## Verification

✅ Verified against codebase: wrapper.ts 2-param signature + per-stream detector (line 238); provider.ts:1746 no detector arg; config.ts:15 `selfDiagnosis: 2`; no `lastUserMessageCount`; nudge-path clears retained. Tests: targeted 32/32 pass; full unstuck suite 344 pass / 2 fail (pre-existing xml guard drift, unrelated — see memory 0011).

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Nudge cycle restarts same doStream — does fresh detector break nudge? | HIGH | Nudge is WITHIN one doStream; detector created at doStream top, `clear()` on nudge still correct |
| Per-stream evidence loses cross-stream accumulation | LOW | Cross-stream evidence was the bug, not a feature |

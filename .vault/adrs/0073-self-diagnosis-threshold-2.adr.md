---
type: adr
id: ADR-0073
title: "Increase Self-Diagnosis Evidence Threshold to 2"
status: accepted
createdAt: "2026-08-10T18:45:00Z"
updatedAt: "2026-08-10T18:45:00Z"
tags: [unstuck, loop-detection, self-diagnosis, thresholds]
supersedes: [ADR-0019]
superseded_by: []
see_also:
  - "adrs/0019-self-diagnosis-detection.adr.md"
  - "adrs/0072-per-stream-loop-detector.adr.md"
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "specifications/0015-fix-false-self-diagnosis-loop.spec.md"
---

# ADR-0073: Increase Self-Diagnosis Evidence Threshold to 2

## Context

`self_diagnosis_loop` fired on a single regex match (threshold 1) in current reasoning or text. Patterns are broad ("I'm stuck", "cannot proceed", "going in circles"). During normal conversation the model naturally uses these phrases — e.g., "I cannot proceed with this approach" — triggering a false positive that cascaded into the nudge cycle.

## Decision

Increase `selfDiagnosis` evidence threshold from 1 to 2: require at least 2 self-diagnosis detections within a single `doStream` before intervention. Implemented via `evidenceThresholds.selfDiagnosis: 2` in `defaultEvidenceThresholds` (config.ts).

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| Threshold 3 | Over-conservative; 2 is a strong signal, real loops produce multiple phrases easily (spec.md §5 suggested 3 — superseded by this decision) |
| Require self-diagnosis AND step loop evidence | Unnecessarily couples independent signals |
| Narrow patterns to "stuck in a loop" only | Loses early detection of genuine stagnation |
| Defer (rely on per-stream isolation only) | Isolation alone still allows one natural-language false match per stream to nudge |

## Consequences

- **Positive:** Eliminates false positives from single natural-language matches; real loops produce multiple self-diagnosis phrases across steps, easily reaching threshold 2.
- **Negative:** A genuine loop saying self-diagnosis language only once per step may reach step 3+ — but step_loop / tool_loop provide complementary coverage.
- **Supersedes:** ADR-0019 (self-diagnosis threshold 1).

## Verification

✅ Verified in code: `config.ts:15` `selfDiagnosis: 2`. Reviewer confirms threshold-2 behavior tests added (loop-detector.test.ts).

---
type: adr
title: "Self-Diagnosis Detection with Immediate Intervention"
id: 4
status: superseded
createdAt: "2026-06-21T00:00:00Z"
updatedAt: "2026-08-10T18:45:00Z"
tags: [unstuck, loop-detection, self-diagnosis]
supersedes: []
superseded_by: [ADR-0073]
deprecated:
  date: 2026-08-10
  reason: "Self-diagnosis evidence threshold raised from 1 to 2 to eliminate natural-language false positives"
  superseded_by: ADR-0073
see_also:
  - "0016-clear-detector-history.adr.md"
  - "0073-self-diagnosis-threshold-2.adr.md"
  - "../specifications/0004-unstuck-loop-detection.spec.md"
---

# ADR-0019: Self-Diagnosis Detection with Immediate Intervention

**ADR ID:** ADR-4
**Status:** superseded by ADR-0073
**Date:** 2026-06-21

> ## Superseded
>
> **2026-08-10:** The "single match triggers" decision (threshold 1) is **superseded** by [[0073-self-diagnosis-threshold-2.adr.md]] (ADR-0073). During normal conversation the model naturally uses phrases like "I cannot proceed" — one match caused false `self_diagnosis_loop` triggers. The evidence threshold is now 2. Keep this ADR as the historical record of the original detection decision (697-run evidence remains relevant context).

## Context

The model literally says "I'm stuck in a loop. Let me try a different approach..." in its reasoning text, but no detection mechanism uses this signal. The model ran 697 times while saying "I'm stuck" — even a single detection would have been sufficient.

## Decision

Add text pattern matching in `finalizeStep()` to detect self-diagnosis phrases in reasoning/text content. A single match (`evidenceThresholds.selfDiagnosis: 1`) triggers a nudge. Pattern matching runs on `currentReasoning` and `currentText` — internal thoughts, reducing false positives from instructional text.

## Alternatives Considered

1. Evidence-based (threshold > 1) — wastes tokens on already-identified loops
2. Embedding-based semantic detection — over-engineered for self-diagnosis
3. No change — misses strongest signal available

## Consequences

- **Positive:** Catches the exact pattern observed (model says "I'm stuck in a loop")
- **Positive:** Minimal overhead (regex matching on text)
- **Risk:** False positive if model instructs user about loops — mitigated: reasoning text, not user-facing
- **Risk:** Language-specific (English only) — acceptable for current usage

## Verification

✅ Confirmed in `loop-detector.ts:17-26` — 5 regex patterns including `stuck in a loop`, `i'm stuck`, `repeating the same`, `going in circles`, `cannot progress/proceed/continue`. Called in `finalizeStep()` at lines 267-278, after loop detection but before reset. Specific nudge message in `wrapper.ts:25-27`.

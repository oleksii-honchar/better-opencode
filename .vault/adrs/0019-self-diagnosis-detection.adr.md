---
type: adr
title: "Self-Diagnosis Detection with Immediate Intervention"
id: 4
status: accepted
createdAt: "2026-06-21T00:00:00Z"
tags: [unstuck, loop-detection, self-diagnosis]
see_also:
  - "0016-clear-detector-history.adr.md"
  - "../specifications/0004-unstuck-loop-detection.spec.md"
---

# ADR-0019: Self-Diagnosis Detection with Immediate Intervention

**ADR ID:** ADR-4
**Status:** accepted
**Date:** 2026-06-21

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

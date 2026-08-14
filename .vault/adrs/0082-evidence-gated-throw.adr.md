---
type: adr
id: ADR-0082
title: "Below-Threshold Detections Continue the Same Stream (Never Full Restart)"
status: accepted
createdAt: "2026-08-14T17:40:00Z"
updatedAt: "2026-08-14T19:00:00Z"
tags: [unstuck, stream, evidence, restart]
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "0083-reasoning-delta-sentence-loop.adr.md"
---

# ADR-0082: Below-Threshold Detections Continue the Same Stream (Never Full Restart)

## Context

`streamWithDetection` threw `LoopDetectedError` on the FIRST detection of any type (wrapper.ts:150). The wrapper catch block handled below-threshold cases by calling `detector.reset()` + `continue` — which re-entered the stream loop and called `model.doStream` AGAIN with the same args (wrapper.ts:355). Already-yielded chunks were NOT rolled back, so the caller saw attempt-1 + attempt-2 output concatenated. The documented contract (docs/spec/08-unstuck-plugin.md:379,405) explicitly promises "continue stream (model may self-correct)" — the implementation restarted instead.

Real-world impact: every detection (even a false positive) cost a full regeneration — the single biggest amplification factor in the observed 4.6M-token / 30× re-read session (ses_ffff5c997ffeeCU3O86rv5JKLV).

## Decision

Move evidence accumulation INTO `streamWithDetection`. On a detection: add evidence; if the intervention threshold is met → throw `LoopDetectedError` (nudge/abort path); otherwise → reset the detector's per-stream loop state and continue the SAME stream. The wrapper catch block handles only threshold-met nudges, `warn`, and `abort`.

Verified in codebase: wrapper.ts:153-167, 182-224 implement the evidence-gated throw; wrapper.test.ts has 46 passing tests confirming single-stream continuation.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Keep restart, raise thresholds | Minimal change | Restart still costs full regeneration on every below-threshold detection; duplicate output persists | Doesn't fix the mechanism |
| Drop detection below threshold entirely | Simplest | Loses evidence accumulation needed for genuine-loop nudges | Evidence-based nudges are the designed recovery |
| Buffer stream until step completes, then decide | No duplicate output | Complex; delays output; invasive to the stream model | Over-engineering for the observed failure |

## Consequences

- **Positive:** below-threshold false positives cost zero regeneration; duplicate output eliminated; evidence still accumulates for genuine loops
- **Negative:** a genuinely stuck stream may produce more tokens before the threshold is met. Mitigated by threshold-met nudge + maxNudges cap

---
type: adr
id: ADR-0072
title: "Per-Stream Loop Detector Instead of Global Singleton"
status: accepted
createdAt: "2026-08-10T18:45:00Z"
updatedAt: "2026-08-10T18:45:00Z"
tags: [unstuck, loop-detection, lifecycle, cross-stream]
supersedes: [ADR-0020]
superseded_by: []
see_also:
  - "adrs/0020-detector-state-sharing.adr.md"
  - "adrs/0016-clear-detector-history.adr.md"
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "specifications/0015-fix-false-self-diagnosis-loop.spec.md"
---

# ADR-0072: Per-Stream Loop Detector Instead of Global Singleton

## Context

The unstuck loop detector (`LoopDetectorImpl`) was a global singleton per model (ADR-0020), created once in `getLanguage` (provider.ts) and reused across ALL `doStream` calls for the model's lifetime. This caused false `self_diagnosis_loop` triggers in long sessions: step fingerprints, streaming state, evidence, and nudgeCount leaked across sessions. The reset logic (`userMessageCount > lastUserMessageCount`) was fragile and failed to reset across session boundaries.

## Decision

Move `LoopDetectorImpl` instantiation from `getLanguage` to inside the `doStream` wrapper. Each `doStream` invocation creates a fresh detector, scoped to that single agent response. `wrapWithLoopDetection(model, config)` no longer accepts a detector parameter — it creates one internally per `doStream` call. The `lastUserMessageCount` reset logic is removed entirely.

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| Keep global detector, add session-scoped clear | Requires plumbing session ID through the call chain; still fragile if session tracking fails |
| Keep global detector, clear on every doStream entry | Defeats the purpose of global state — same as creating a new one |
| Keep global detector, fix count-based reset | Addresses symptoms not root cause; cross-stream history still pollutes detection |
| Re-add `detector.clear()` on clean completion (revert ADR-0016) | Reverts history-based detection entirely — defeats ADR-0016's purpose |

## Consequences

- **Positive:** Eliminates cross-session state leakage (root cause of false positives); removes fragile reset logic; detector dies with the stream on interruption/error; simpler lifecycle reasoning.
- **Negative:** `wrapWithLoopDetection` signature changes (3 → 2 params) — call sites and tests updated; cross-stream evidence accumulation lost (was the bug, not a feature).
- **Reverses:** ADR-0020 (global singleton per model) — reversed for the detector; the wrapped function remains cached.
- **Unaffected:** ADR-0016 (clear removed from clean completion), ADR-0021 (loop reflection in nudges).

## Verification

✅ Verified in code: `wrapper.ts:205-208` signature `(model, config)`; `wrapper.ts:238` `new LoopDetectorImpl()` inside `doStream`; `provider.ts:1746` `wrapWithLoopDetection(language, unstuckConfig)` with no detector arg; no `lastUserMessageCount` in wrapper.ts (rg 0 matches); `detector.clear()`/`evidence.clear()` retained on nudge path (wrapper.ts:371-372).

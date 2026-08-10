---
type: adr
title: "Detector State Sharing — No Per-Thread Isolation Needed"
id: 5
status: deprecated
createdAt: "2026-06-21T00:00:00Z"
updatedAt: "2026-08-10T18:45:00Z"
tags: [unstuck, loop-detection, state, cross-stream]
supersedes: []
superseded_by: [ADR-0072]
deprecated:
  date: 2026-08-10
  reason: "Reversed — detector moved from global singleton per model to per-stream instance inside each doStream call"
  superseded_by: ADR-0072
see_also:
  - "0016-clear-detector-history.adr.md"
  - "0072-per-stream-loop-detector.adr.md"
  - "../concepts/0007-unstuck-loop-detection.concept.md"
---

# ADR-0020: Detector State Sharing — No Per-Thread Isolation Needed

**ADR ID:** ADR-5
**Status:** deprecated (superseded by ADR-0072)
**Date:** 2026-06-21

> ## Superseded
>
> **2026-08-10:** This decision is **reversed** by [[0072-per-stream-loop-detector.adr.md]] (ADR-0072). The "no per-thread isolation needed" reasoning assumed a sandbox where shared state is acceptable — but the global singleton leaked step fingerprints, streaming state, evidence, and nudgeCount across sessions, causing false `self_diagnosis_loop` triggers. The detector is now per-stream; the wrapped function remains cached per model. Keep this ADR as the historical record of the prior design.

## Context

The `LoopDetectorImpl` is instantiated once per model and cached globally via `provider.ts:1749`. With cross-stream history preservation (ADR-1), a single detector instance accumulates steps across multiple conversations/threads. In sandbox mode (Codex IDE — no `permission:` system), all session flow agents share unrestricted write access to `~/`. Thread isolation is deliberately absent.

## Decision

Do NOT add per-thread detector isolation. The `historySize: 10` sliding window is sufficient. Old history from other threads naturally evicts after 10 steps.

## Alternatives Considered

1. Per-call detector + external accumulator — over-engineered; sandbox environment doesn't need thread isolation
2. Async local storage — fragile, introduces thread-tracking complexity for no benefit
3. Thread-scoped detector with session ID — solves a problem that doesn't exist in sandbox mode

## Consequences

- **Positive:** Zero code change for isolation — simplest possible P0 fix (just remove `detector.clear()`)
- **Positive:** Matches sandbox environment design (shared state is expected)
- **Risk:** If a non-sandbox mode is added later, this ADR would need revisiting
- **Risk:** Fast threads could dominate history — mitigated by evidence threshold (needs 2+ detection events)

## Verification

✅ Confirmed in `loop-detector.ts:239-241` — sliding window: `if (this.history.length > config.historySize) { this.history.shift() }`. `historySize: 10` in `config.ts`.

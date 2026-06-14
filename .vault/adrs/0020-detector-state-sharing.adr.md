---
type: adr
title: "Detector State Sharing — No Per-Thread Isolation Needed"
id: 5
status: accepted
createdAt: "2026-06-21T00:00:00Z"
tags: [unstuck, loop-detection, state, cross-stream]
see_also:
  - "0016-clear-detector-history.adr.md"
  - "../concepts/0007-unstuck-loop-detection.concept.md"
---

# ADR-0020: Detector State Sharing — No Per-Thread Isolation Needed

**ADR ID:** ADR-5
**Status:** accepted
**Date:** 2026-06-21

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

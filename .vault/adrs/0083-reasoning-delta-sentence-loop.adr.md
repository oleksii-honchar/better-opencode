---
type: adr
id: ADR-0083
title: "Exclude Reasoning-Delta from sentence_loop Detection by Default"
status: accepted
createdAt: "2026-08-14T17:40:00Z"
updatedAt: "2026-08-14T19:00:00Z"
tags: [unstuck, sentence-loop, reasoning-delta, false-positive]
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "0082-evidence-gated-throw.adr.md"
---

# ADR-0083: Exclude Reasoning-Delta from sentence_loop Detection by Default

## Context

`sentenceTracker.consumeText` ran on EVERY `reasoning-delta` AND `text-delta` chunk (loop-detector.ts:133-138, 149-154). Frontier reasoning models frequently repeat phrases in chain-of-thought — that's normal behavior. Default evidence threshold `sentenceLoop: 1` meant a single periodic CoT repetition immediately nudged + restarted.

Verified in codebase: config.ts defines `sentenceLoopIncludeReasoning: boolean = false`; loop-detector.ts:155 gates reasoning-delta feeding on this flag; loop-detector.test.ts has dedicated tests.

## Decision

Add config `sentenceLoopIncludeReasoning: boolean` (default `false`). Feed the sentence tracker from `reasoning-delta` only when the flag is true; always feed from `text-delta`. Raise `defaultEvidenceThresholds.sentenceLoop` from 1 → 3.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Keep reasoning detection, raise threshold | Keeps capability | Frontier CoT repeats frequently — threshold tuning is fragile across models | Explicit exclusion is more predictable |
| Remove sentence_loop entirely | Simplest | Loses a real stuck signal in final text | Text-delta detection retained |

## Consequences

- **Positive:** CoT repetition no longer triggers nudges by default
- **Negative:** genuine CoT-only loops are no longer caught by sentence_loop (still caught by step_loop/pattern_loop fingerprints which include reasoning)

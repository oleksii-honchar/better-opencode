---
type: adr
id: ADR-0061
title: "New Dedicated doom_loop Detection Type over Reusing tool_loop"
status: accepted
createdAt: "2026-08-01T13:22:43Z"
updatedAt: "2026-08-01T13:22:43Z"
tags: [unstuck, doom-loop, loop-detection, tool-loop]
supersedes: []
superseded_by: []
see_also:
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "specifications/0012-doom-loop-nudge.spec.md"
  - "adrs/0060-allow-then-catch-doom-loop.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0061: New Dedicated doom_loop Detection Type over Reusing tool_loop

## Context

Unstuck already had `tool_loop` detection (`toolLoopThreshold: 6`, across steps, with gap tolerance). The processor's doom_loop fires at **3 consecutive same-tool-same-input within a single message** — a different, stricter, within-step pattern. Lowering `toolLoopThreshold` to 3 would change cross-step tool-loop semantics and still lack the exact-input-equality requirement.

## Decision

Add a dedicated `doom_loop` detection type that checks 3 consecutive identical (tool name + exact `JSON.stringify(input)`) tool calls within the current step, configurable via `doomLoopThreshold` (default 3) and `enableDoomLoopDetection` (default true).

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Lower `toolLoopThreshold` to 3 | Reuses existing machinery | Changes cross-step semantics; lacks exact-input check | Rejected |
| Reuse `computeToolSignature` (normalized) | Normalized comparison | Case/whitespace differences merge distinct inputs (false positives) | Rejected — exact `JSON.stringify` equality gives parity with the processor |

## Consequences

- **Positive:** mirrors the processor's `DOOM_LOOP_THRESHOLD` semantics exactly; does not perturb existing `tool_loop` behavior; follows the established pattern for new detection types (config flag + threshold + evidence threshold + nudge message).
- **Neutral:** new union members in `LoopDetectedInfo.type` and `EvidenceRecord.type` — additive for all consumers; evidence threshold `doomLoop: 1` (a single detection is already a strong signal — 3 identical calls occurred).

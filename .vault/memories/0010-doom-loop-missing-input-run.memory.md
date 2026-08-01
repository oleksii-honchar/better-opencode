---
type: memory
title: "Missing-Input Call Does Not Reset Doom Loop Run"
createdAt: "2026-08-01T13:22:43Z"
updatedAt: "2026-08-01T13:22:43Z"
tags: [unstuck, doom-loop, gotcha, edge-case]
see_also:
  - "adrs/0061-dedicated-doom-loop-detection.adr.md"
  - "specifications/0012-doom-loop-nudge.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: Missing-Input Call Does Not Reset Doom Loop Run

## Fact

A `_missing`-input call does not reset `currentDoomRun` in the unstuck doom_loop detector. Sequence A, `_missing`, A, A → doom_loop detected in unstuck, but the processor's last-3-parts check would NOT fire (a `{_missing}` part breaks identity).

## Context

Found during the 2026-08-01 review of the doom_loop → unstuck nudge implementation (loop-detector.ts). The detector skips `_missing` inputs (L4 "missing-input") but keeps the run alive across them.

## Impact

Minor false-positive divergence from processor semantics. Practical impact minimal — a nudge, never an abort, below maxNudges. Future cleanup: reset the run on `_missing`.

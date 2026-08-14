---
type: adr
id: ADR-0087
title: "Cross-Stream Doom-Loop Detection Opt-In by Default"
status: accepted
createdAt: "2026-08-14T17:40:00Z"
updatedAt: "2026-08-14T19:00:00Z"
tags: [unstuck, doom-loop, cross-stream, opt-in]
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "0074-cross-stream-doom-loop-detection.adr.md"
  - "../memories/0015-cross-stream-detection-gap.memory.md"
---

# ADR-0087: Cross-Stream Doom-Loop Detection Opt-In by Default

## Context

`enableCrossStreamDoomLoopDetection` defaulted true, but the manager tracked ONE last-call per session (cross-stream-doom-loop.ts:16-26) — any interleaved different call reset the run. Memory 0015 documented that 30 identical sed calls across 30 streams never triggered. The detector is simultaneously too weak (misses interleaved loops) and a bookkeeping overhead.

Verified in codebase: config.ts has `enableCrossStreamDoomLoopDetection: false` as default.

## Decision

Default `enableCrossStreamDoomLoopDetection: false`. Keep the code path and integration tests for opt-in users.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Fix the single-state weakness (per-key rolling counts) | Makes cross-stream detection work | Adds complexity to cross-stream-doom-loop.ts for a rarely-triggered path | Defer; per-stream doom_loop is the primary detector |
| Keep default true | Matches ADR-0074 intent | Weak detector fires rarely but costs per-tool-call bookkeeping | Opt-in is honest |

## Consequences

- **Positive:** less overhead; no cross-stream false positives by default
- **Negative:** cross-stream identical calls (e.g. the sed incident) go undetected unless enabled

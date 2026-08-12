---
type: memory
title: "Cross-Stream Doom-Loop Detection Gap (Per-Stream Isolation)"
createdAt: "2026-08-12T20:00:00Z"
updatedAt: "2026-08-12T20:00:00Z"
tags: [unstuck, doom-loop, cross-stream, gotcha, incident]
see_also:
  - "../adrs/0074-cross-stream-doom-loop-detection.adr.md"
  - "../concepts/0007-unstuck-loop-detection.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: Cross-Stream Doom-Loop Detection Gap (Per-Stream Isolation)

## Fact

The per-stream loop detector (ADR-0072) creates a fresh `LoopDetectorImpl` per `doStream` call, so it can never observe more than one identical tool call in any single stream. Identical tool calls across multiple streams are invisible to the detector until ADR-0074's cross-stream layer was added.

## Context

In session `ses_009302293ffe3KacIsKYNnejAD`, an agent called `sed -i "s/17 files/14 files/g"` 30 times across 30 separate streams. Each stream saw exactly 1 sed call — the doom-loop threshold of 3 was never reached. The model self-escaped after ~147 seconds with no intervention. The processor-level `doom_loop` gate was also blind: it checks only the last 3 parts of the current assistant message (1 part per message = never matches).

## Impact

Before ADR-0074: cross-stream doom loops were undetectable — a fundamental blind spot for any repeated-failure scenario where each call was a separate stream. After ADR-0074: the `CrossStreamDoomLoopManager` tracks per-session rolling records, catching these loops with the same threshold of 3.

**Lesson:** Per-stream isolation (ADR-0072) is correct for preventing cross-session leakage, but it creates a cross-stream blind spot that requires a separate detection layer at the provider/wrapper level.

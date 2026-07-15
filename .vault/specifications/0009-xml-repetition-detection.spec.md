---
type: specification
title: "Real-time XML Repetition Detection for Tool Call Streaming"
kind: feature
status: completed
createdAt: "2026-07-15T09:00:00Z"
updatedAt: "2026-07-15T09:00:00Z"
tags: [unstuck, loop-detection, xml-repetition, qwen, streaming]
owner: ""
target: null
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "../adrs/0051-xml-repetition-detection.adr.md"
  - "0004-unstuck-loop-detection.spec.md"
---

# SPEC-0009: Real-time XML Repetition Detection for Tool Call Streaming

## Goal

Add real-time XML tag repetition detection to the existing unstuck plugin, operating during stream consumption to detect and interrupt XML repetition patterns in Qwen models before they consume excessive tokens (preventing 32k-token runaway generations).

## Scope

- XmlRepetitionDetector component for within-stream XML tag repetition detection
- Token-based interruption limits (per-tool and total)
- Integration with existing LoopDetectorImpl and nudge-and-prune recovery
- Configuration options (thresholds, token limits, enable/disable)

## Phases

### Phase 1 — Core Detection Infrastructure (COMPLETED)
- [x] Implement `XmlRepetitionDetector` class
- [x] Tag extraction and normalization via regex patterns
- [x] Token counting (character-based estimation)
- [x] Repetition detection logic (sliding window)
- [x] Write comprehensive tests

### Phase 2 — Integration with LoopDetector (COMPLETED)
- [x] Extend `UnstuckConfig` with XML repetition fields
- [x] Add `xml_repetition` to `LoopDetectedInfo.type` union
- [x] Integrate detector into `LoopDetectorImpl`
- [x] Connect detection to stream interruption
- [x] Update tests

### Phase 3 — Configuration (COMPLETED)
- [x] Add config schema fields to `config.ts`
- [x] Add default values to `defaultConfig`
- [x] Add merge support in `mergeConfig`

### Phase 4 — Documentation & Validation (COMPLETED)
- [x] Update concept in vault
- [x] Create specification in vault
- [x] Run full test suite
- [x] Manual validation

## Implementation Status

✅ All 4 phases implemented. 6/6 tasks complete. Zero critical issues. All 23 spec components verified by reviewer.

## Files Created / Modified

### New Files
- `packages/opencode/src/plugin/unstuck/xml-repetition-detector.ts` — XmlRepetitionDetector class
- `packages/opencode/src/plugin/unstuck/xml-repetition-detector.test.ts` — Unit tests

### Modified Files
- `packages/opencode/src/plugin/unstuck/loop-detector.ts` — Integration with detector
- `packages/opencode/src/plugin/unstuck/config.ts` — Extended UnstuckConfig
- `packages/opencode/src/plugin/unstuck/error.ts` — Added xml_repetition type
- `packages/opencode/src/plugin/unstuck/wrapper.ts` — Stream interruption hooks
- `packages/opencode/src/config/config.ts` — Config schema extension

## Behaviors

- **Given** a Qwen model begins repeating XML `<param>` tags during a tool call
- **When** the repetition threshold is exceeded (default: 4 identical tags within window of 10)
- **Then** the stream is interrupted and nudge-and-prune recovery is triggered

- **Given** a tool call exceeds 4000 tokens
- **When** the per-tool token limit is hit
- **Then** the stream is interrupted regardless of repetition count

- **Given** total tool input exceeds 16000 tokens across all tools
- **When** the total token limit is hit
- **Then** the stream is interrupted

## Risks

- **Risk:** False positives on legitimate long tool calls — **Mitigation:** Generous limits (4k per tool, 16k total, 4-tag threshold)
- **Risk:** Model continues generating after interruption — **Mitigation:** Token limits as ultimate fallback
- **Risk:** Performance overhead on tool calls — **Mitigation:** Minimal — simple counter + hash per chunk

## Links

- ADR-0051: Design decision for XML repetition detection
- SPEC-0004: Prior unstuck loop detection improvements
- CONCEPT-0007: Unstuck Loop Detection System (updated with 6th type)

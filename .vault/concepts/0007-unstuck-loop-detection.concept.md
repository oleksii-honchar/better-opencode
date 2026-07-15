---
type: concept
title: "Unstuck Loop Detection System"
createdAt: "2026-06-21T00:00:00Z"
updatedAt: "2026-07-15T15:00:00Z"
tags: [unstuck, loop-detection, fingerprint, nudge-and-prune, xml-repetition, partial-tags, model-thresholds]
see_also:
  - "../specifications/0004-unstuck-loop-detection.spec.md"
  - "../specifications/0009-xml-repetition-detection.spec.md"
  - "../specifications/0010-enhanced-xml-detection.spec.md"
  - "../adrs/0016-clear-detector-history.adr.md"
  - "../adrs/0020-detector-state-sharing.adr.md"
  - "../adrs/0051-xml-repetition-detection.adr.md"
  - "../adrs/0052-enhanced-xml-detection.adr.md"
---

# CONCEPT-0007: Unstuck Loop Detection System

**Date:** 2026-06-21
**Updated:** 2026-07-15 (added partial/prefix XML detection, model-specific thresholds, user message reset)

## What

The unstuck plugin is a two-level loop detection system operating at the LLM stream level. It prevents AI agents from getting stuck in infinite loops by detecting repetitive patterns and applying nudge-and-prune interventions.

## Why

LLM agents frequently enter behavioral loops (e.g., 697+ iterations of the same tool call) that waste tokens and compute time. The system provides automated detection and course-correction without human intervention.

## Key Details

- **Architecture:** Two-level — `LoopDetectorImpl` (detection) + `wrapWithLoopDetection` (stream wrapper)
- **Detection types:** 6 types — `step_loop` (identical step fingerprints), `tool_loop` (identical tools with gap tolerance), `sentence_loop` (periodic sentence repetition within a step), `self_diagnosis_loop` (model acknowledges being stuck), `pattern_loop` (period-2 alternating pattern), `xml_repetition` (repeating XML tags within tool input stream, including partial/prefix tags)
- **Fingerprinting:** FNV-1a hash of normalized thinking text + tool signatures → step fingerprint
- **Evidence accumulation:** Multiple detection events must be accumulated before intervention (thresholds: 2 for step/tool/pattern, 1 for self-diagnosis/sentence)
- **Intervention strategies:** `nudge-and-prune` (inject user message + prune looping messages), `abort` (throw), `warn` (log and rethrow)
- **Cross-stream history:** `detector.clear()` removed from clean-completion path; history preserved across LLM call streams (ADR-0016), capped at `historySize: 10`
- **User message reset:** `detector.clear()`, `evidence.clear()`, `nudgeCount=0` on new user message (detects by counting user messages in prompt)
- **Legacy doom_loop:** `DOOM_LOOP_THRESHOLD = 3` in `processor.ts` — detects within-message repetition (separate from unstuck plugin)

### XML Repetition Detection (ADR-0051, ADR-0052)

- **Three completeness levels:** `TagEntry.completeness` — `"complete"` (full opening+closing), `"partial"` (opening only), `"prefix"` (tag name prefix)
- **Three regex families:** complete tags (`XML_TAG_PATTERN`), opening-only (`XML_OPENING_TAG_PATTERN`), malformed (`MALFORMED_PATTERN`)
- **Dual thresholds:** `repetitionThreshold` (complete tags, default: 4) and `partialTagThreshold` (partial/prefix, default: 2)
- **Model-specific thresholds:** Qwen models use lower thresholds (repetition=3, partial=2, maxToolInputTokens=2500)
- **Token estimation:** XML-aware with configurable `xmlTokenEstimationMultiplier` (default: 1.5x) — `Math.ceil(text.length / 4 * multiplier)`
- **Config:** `xmlRepetitionModelId`, `xmlPartialTagThreshold`, `xmlTokenEstimationMultiplier`, `xmlPartialTagDetection`
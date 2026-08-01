---
type: concept
title: "Unstuck Loop Detection System"
createdAt: "2026-06-21T00:00:00Z"
updatedAt: "2026-08-01T13:22:43Z"
tags: [unstuck, loop-detection, fingerprint, nudge-and-prune, xml-repetition, partial-tags, model-thresholds, doom-loop]
see_also:
  - "../specifications/0004-unstuck-loop-detection.spec.md"
  - "../specifications/0009-xml-repetition-detection.spec.md"
  - "../specifications/0010-enhanced-xml-detection.spec.md"
  - "../specifications/0012-doom-loop-nudge.spec.md"
  - "../adrs/0016-clear-detector-history.adr.md"
  - "../adrs/0020-detector-state-sharing.adr.md"
  - "../adrs/0051-xml-repetition-detection.adr.md"
  - "../adrs/0052-enhanced-xml-detection.adr.md"
  - "../adrs/0060-allow-then-catch-doom-loop.adr.md"
  - "../adrs/0061-dedicated-doom-loop-detection.adr.md"
  - "../adrs/0062-doom-loop-permission-allow-default.adr.md"
  - "../adrs/0063-no-processor-change-nudge-path.adr.md"
  - "../adrs/0064-doom-loop-config-migration.adr.md"
---

# CONCEPT-0007: Unstuck Loop Detection System

**Date:** 2026-06-21
**Updated:** 2026-07-15 (added partial/prefix XML detection, model-specific thresholds, user message reset)
**Updated:** 2026-08-01 (added doom_loop detection — Allow-then-Catch; unstuck now owns doom-loop recovery)

## What

The unstuck plugin is a two-level loop detection system operating at the LLM stream level. It prevents AI agents from getting stuck in infinite loops by detecting repetitive patterns and applying nudge-and-prune interventions.

## Why

LLM agents frequently enter behavioral loops (e.g., 697+ iterations of the same tool call) that waste tokens and compute time. The system provides automated detection and course-correction without human intervention.

## Key Details

- **Architecture:** Two-level — `LoopDetectorImpl` (detection) + `wrapWithLoopDetection` (stream wrapper)
- **Detection types:** 7 types — `step_loop` (identical step fingerprints), `tool_loop` (identical tools with gap tolerance), `sentence_loop` (periodic sentence repetition within a step), `self_diagnosis_loop` (model acknowledges being stuck), `pattern_loop` (period-2 alternating pattern), `xml_repetition` (repeating XML tags within tool input stream, including partial/prefix tags), `doom_loop` (3× same tool + exact same input within current step)
- **Fingerprinting:** FNV-1a hash of normalized thinking text + tool signatures → step fingerprint
- **Evidence accumulation:** Multiple detection events must be accumulated before intervention (thresholds: 2 for step/tool/pattern, 1 for self-diagnosis/sentence/doom_loop)
- **Intervention strategies:** `nudge-and-prune` (inject user message + prune looping messages), `abort` (throw), `warn` (log and rethrow)
- **Cross-stream history:** `detector.clear()` removed from clean-completion path; history preserved across LLM call streams (ADR-0016), capped at `historySize: 10`
- **User message reset:** `detector.clear()`, `evidence.clear()`, `nudgeCount=0` on new user message (detects by counting user messages in prompt)

### Doom Loop Detection (ADR-0060…0064, spec 0012)

- **Pattern:** 3 consecutive identical (tool name + exact `JSON.stringify(input)`) tool calls **within the current step** — mirrors the processor's `DOOM_LOOP_THRESHOLD = 3` semantics.
- **Allow-then-Catch:** the default `doom_loop` permission is `allow` (agent.ts:126) — the processor no longer hard-stops; unstuck intercepts at the 3rd `tool-input-end` (before the `tool-call` event) and nudges via nudge-and-prune.
- **Config:** `enableDoomLoopDetection` (default true), `doomLoopThreshold` (default 3), `evidenceThresholds.doomLoop` (default 1).
- **Fingerprint:** `fnv1a(JSON.stringify(input))` — sync hash for exact-input equality (documented deviation from spec's sha256 proposal, memory 0009).
- **Skipped when:** input resolution failed (`{ _missing: true }`) or provider-executed tools.
- **Processor unchanged:** `DOOM_LOOP_THRESHOLD` stays as the fallback guard, now resolving to `allow` (ADR-0063).
- **Config migration:** users with explicit `doom_loop: deny` in agent configs must remove the key (new default is `allow`) — ADR-0064.

### XML Repetition Detection (ADR-0051, ADR-0052)

- **Three completeness levels:** `TagEntry.completeness` — `"complete"` (full opening+closing), `"partial"` (opening only), `"prefix"` (tag name prefix)
- **Three regex families:** complete tags (`XML_TAG_PATTERN`), opening-only (`XML_OPENING_TAG_PATTERN`), malformed (`MALFORMED_PATTERN`)
- **Dual thresholds:** `repetitionThreshold` (complete tags, default: 4) and `partialTagThreshold` (partial/prefix, default: 2)
- **Model-specific thresholds:** Qwen models use lower thresholds (repetition=3, partial=2, maxToolInputTokens=2500)
- **Token estimation:** XML-aware with configurable `xmlTokenEstimationMultiplier` (default: 1.5x) — `Math.ceil(text.length / 4 * multiplier)`
- **Config:** `xmlRepetitionModelId`, `xmlPartialTagThreshold`, `xmlTokenEstimationMultiplier`, `xmlPartialTagDetection`

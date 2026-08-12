---
type: concept
title: "Unstuck Loop Detection System"
createdAt: "2026-06-21T00:00:00Z"
updatedAt: "2026-08-12T18:50:00Z"
tags: [unstuck, loop-detection, fingerprint, nudge-and-prune, xml-repetition, partial-tags, model-thresholds, doom-loop, cross-stream]
see_also:
  - "../specifications/0004-unstuck-loop-detection.spec.md"
  - "../specifications/0009-xml-repetition-detection.spec.md"
  - "../specifications/0010-enhanced-xml-detection.spec.md"
  - "../specifications/0012-doom-loop-nudge.spec.md"
  - "../specifications/0015-fix-false-self-diagnosis-loop.spec.md"
  - "../adrs/0016-clear-detector-history.adr.md"
  - "../adrs/0020-detector-state-sharing.adr.md"
  - "../adrs/0051-xml-repetition-detection.adr.md"
  - "../adrs/0052-enhanced-xml-detection.adr.md"
  - "../adrs/0060-allow-then-catch-doom-loop.adr.md"
  - "../adrs/0061-dedicated-doom-loop-detection.adr.md"
  - "../adrs/0062-doom-loop-permission-allow-default.adr.md"
  - "../adrs/0063-no-processor-change-nudge-path.adr.md"
  - "../adrs/0064-doom-loop-config-migration.adr.md"
  - "../adrs/0072-per-stream-loop-detector.adr.md"
  - "../adrs/0073-self-diagnosis-threshold-2.adr.md"
  - "../adrs/0074-cross-stream-doom-loop-detection.adr.md"
---

# CONCEPT-0007: Unstuck Loop Detection System

**Date:** 2026-06-21
**Updated:** 2026-07-15 (added partial/prefix XML detection, model-specific thresholds, user message reset)
**Updated:** 2026-08-01 (added doom_loop detection — Allow-then-Catch; unstuck now owns doom-loop recovery)
**Updated:** 2026-08-12 (added cross-stream doom-loop detection — ADR-0074)

## What

The unstuck plugin is a two-level loop detection system operating at the LLM stream level. It prevents AI agents from getting stuck in infinite loops by detecting repetitive patterns and applying nudge-and-prune interventions.

## Why

LLM agents frequently enter behavioral loops (e.g., 697+ iterations of the same tool call) that waste tokens and compute time. The system provides automated detection and course-correction without human intervention.

## Key Details

- **Architecture:** Two-level — `LoopDetectorImpl` (detection) + `wrapWithLoopDetection` (stream wrapper)
- **Detection types:** 7 types — `step_loop` (identical step fingerprints), `tool_loop` (identical tools with gap tolerance), `sentence_loop` (periodic sentence repetition within a step), `self_diagnosis_loop` (model acknowledges being stuck), `pattern_loop` (period-2 alternating pattern), `xml_repetition` (repeating XML tags within tool input stream, including partial/prefix tags), `doom_loop` (3× same tool + exact same input within current step)
- **Fingerprinting:** FNV-1a hash of normalized thinking text + tool signatures → step fingerprint
- **Evidence accumulation:** Multiple detection events must be accumulated before intervention (thresholds: 2 for step/tool/pattern/self-diagnosis, 1 for sentence/doom_loop)
- **Intervention strategies:** `nudge-and-prune` (inject user message + prune looping messages), `abort` (throw), `warn` (log and rethrow)
- **Per-stream lifecycle (ADR-0072):** the detector is scoped to ONE `doStream` call — `new LoopDetectorImpl()` inside `doStream` (wrapper.ts:238); the wrapped function remains cached per model in `s.models`; each agent response starts with a fresh detector, so no cross-stream history, evidence, or nudgeCount accumulation (reverses the ADR-0020 global-singleton design)
- **No user-message reset needed:** the fragile `userMessageCount > lastUserMessageCount` reset was removed — each `doStream` starts clean; `detector.clear()` / `evidence.clear()` retained only on the nudge path (a nudge restarts the SAME doStream)
- **Self-diagnosis threshold 2 (ADR-0073):** `evidenceThresholds.selfDiagnosis: 2` — a single natural-language phrase ("I cannot proceed") no longer triggers intervention; two self-diagnosis detections within one response do (supersedes ADR-0019 threshold 1)

### Doom Loop Detection (ADR-0060…0064, spec 0012)

- **Pattern:** 3 consecutive identical (tool name + exact `JSON.stringify(input)`) tool calls **within the current step** — mirrors the processor's `DOOM_LOOP_THRESHOLD = 3` semantics.
- **Allow-then-Catch:** the default `doom_loop` permission is `allow` (agent.ts:126) — the processor no longer hard-stops; unstuck intercepts at the 3rd `tool-input-end` (before the `tool-call` event) and nudges via nudge-and-prune.
- **Config:** `enableDoomLoopDetection` (default true), `doomLoopThreshold` (default 3), `evidenceThresholds.doomLoop` (default 1).
- **Fingerprint:** `fnv1a(JSON.stringify(input))` — sync hash for exact-input equality (documented deviation from spec's sha256 proposal, memory 0009).
- **Skipped when:** input resolution failed (`{ _missing: true }`) or provider-executed tools.
- **Processor unchanged:** `DOOM_LOOP_THRESHOLD` stays as the fallback guard, now resolving to `allow` (ADR-0063).
- **Config migration:** users with explicit `doom_loop: deny` in agent configs must remove the key (new default is `allow`) — ADR-0064.

### Cross-Stream Doom-Loop Detection (ADR-0074)

- **Gap:** Per-stream detector (ADR-0072) sees at most 1 call per `doStream` — when an agent calls the same tool with identical input across multiple streams, the threshold (default 3) is never reached.
- **Incident:** Session `ses_009302293ffe3KacIsKYNnejAD` — 30 identical `sed -i` calls across 30 streams, never detected; model self-escaped after ~147s.
- **Solution:** Per-session rolling record in `CrossStreamDoomLoopManager` (keyed by session ID from `<env>` block). After per-step doom-loop detection in `streamWithDetection`, check the session record. If (tool name + input fingerprint) matches, increment count; if count >= threshold, trigger nudge-and-prune.
- **Reset:** On nudge, `resetSession(sessionId)` clears the counter. On session end, `clearAll()` clears all records.
- **Config:** `enableCrossStreamDoomLoopDetection` (default true), `crossStreamDoomLoopThreshold` (default 3).
- **Session ID extraction:** Regex on `Session ID: ses_xxxxx` from prompt's `<env>` block; fallback to empty string (no cross-stream detection for that call).
- **Preserves per-stream isolation:** additive to ADR-0072 — the per-stream detector still operates independently; cross-stream detection is a separate layer at the provider/wrapper level.

### XML Repetition Detection (ADR-0051, ADR-0052)

- **Three completeness levels:** `TagEntry.completeness` — `"complete"` (full opening+closing), `"partial"` (opening only), `"prefix"` (tag name prefix)
- **Three regex families:** complete tags (`XML_TAG_PATTERN`), opening-only (`XML_OPENING_TAG_PATTERN`), malformed (`MALFORMED_PATTERN`)
- **Dual thresholds:** `repetitionThreshold` (complete tags, default: 4) and `partialTagThreshold` (partial/prefix, default: 2)
- **Model-specific thresholds:** Qwen models use lower thresholds (repetition=3, partial=2, maxToolInputTokens=2500)
- **Token estimation:** XML-aware with configurable `xmlTokenEstimationMultiplier` (default: 1.5x) — `Math.ceil(text.length / 4 * multiplier)`
- **Config:** `xmlRepetitionModelId`, `xmlPartialTagThreshold`, `xmlTokenEstimationMultiplier`, `xmlPartialTagDetection`

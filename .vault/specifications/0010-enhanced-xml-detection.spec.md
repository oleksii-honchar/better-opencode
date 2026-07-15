---
type: specification
title: "Enhanced XML Repetition Detection — Partial/Malformed Tag Support"
kind: feature
status: completed
createdAt: "2026-07-15T15:00:00Z"
updatedAt: "2026-07-15T15:00:00Z"
tags: [unstuck, loop-detection, xml-repetition, qwen, partial-tags]
owner: ""
target: null
see_also:
  - "0009-xml-repetition-detection.spec.md"
  - "0004-unstuck-loop-detection.spec.md"
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "../adrs/0052-enhanced-xml-detection.adr.md"
---

# SPEC-0010: Enhanced XML Repetition Detection — Partial/Malformed Tag Support

## Goal

Extend the XmlRepetitionDetector (SPEC-0009) to catch partial/malformed XML tags that Qwen models produce, fix falsy value coercion bugs, add model-specific thresholds, and reset detector state on new user messages.

## Scope

- Partial/incomplete tag detection via additional regex patterns
- Prefix-based detection for repeated opening tags
- Tag completeness tracking (`"complete" | "partial" | "prefix"`)
- Model-specific thresholds (Qwen: repetition=3, partial=2, tokens=2500)
- XML-aware token estimation with configurable multiplier (default: 1.5)
- Bug fix: falsy value coercion in mapRepetitionToLoopInfo
- Bug fix: detector/evidence reset on new user message
- Configuration: 4 new fields in UnstuckConfig

## Phases

### Phase 0 — Bug Fixes (CRITICAL) (COMPLETED)
- [x] Fix falsy value coercion in mapRepetitionToLoopInfo (loop-detector.ts:415-416)
- [x] Add detector/evidence reset in doStream method (wrapper.ts:220-230)
- [x] Add test for token limit exceeded scenario
- [x] Add test for detector reset on new user message

### Phase 1 — Enhanced Detection Patterns (COMPLETED)
- [x] Add new regex patterns (XML_OPENING_TAG_PATTERN, XML_CLOSING_TAG_PATTERN, MALFORMED_PATTERN)
- [x] Implement prefix-based detection (extractTagPrefixes)
- [x] Update TagEntry with completeness field
- [x] Add model-specific threshold handling (qwen: repetition=3, partial=2, tokens=2500)
- [x] Improve token estimation with XML multiplier (1.5x default)
- [x] Write 121 comprehensive malformed XML tests

### Phase 2 — Integration (COMPLETED)
- [x] Pass model ID from provider → LoopDetectorImpl → XmlRepetitionDetector
- [x] Move token estimation to XmlRepetitionDetector
- [x] Add debug logging for partial/prefix tag detection

### Phase 3 — Configuration (COMPLETED)
- [x] Add 4 new config fields (modelId, partialTagThreshold, tokenEstimationMultiplier, partialTagDetection)
- [x] Set backward-compatible defaults
- [x] Wire validateUnstuckConfig into mergeConfig

## Implementation Status

All 15 tasks implemented. 296 tests passing (748 expect calls across 5 test files). 1 pre-existing test failure. All 74 acceptance criteria verified.

## Files Changed

### Modified Files
- `packages/opencode/src/plugin/unstuck/xml-repetition-detector.ts` — Enhanced detection, completeness, model thresholds
- `packages/opencode/src/plugin/unstuck/xml-repetition-detector.test.ts` — 121 malformed XML tests
- `packages/opencode/src/plugin/unstuck/loop-detector.ts` — Falsy coercion fix, model ID propagation
- `packages/opencode/src/plugin/unstuck/loop-detector.test.ts` — Updated tests
- `packages/opencode/src/plugin/unstuck/wrapper.ts` — Detector/evidence reset on new user message
- `packages/opencode/src/plugin/unstuck/config.ts` — 4 new config fields, validation
- `packages/opencode/src/config/config.test.ts` — Config validation tests

## Behaviors

- **Given** a Qwen model produces partial `<parameter>` tags without closing
- **When** partialTagThreshold (2) is reached
- **Then** stream is interrupted with xml_repetition error

- **Given** a Qwen model produces prefix patterns like `<parameter=oldString>`
- **When** prefix count reaches partialTagThreshold (2)
- **Then** stream is interrupted with xml_repetition error

- **Given** model ID is "qwen3.6-40b"
- **When** repetition threshold check runs
- **Then** uses repetition=3, partial=2, tokens=2500 (not defaults 4, 4, 4000)

- **Given** a new user message is sent
- **When** doStream is called
- **Then** detector.clear(), evidence.clear(), nudgeCount=0

- **Given** a token limit error occurs with empty tagName or zero repetitionCount
- **When** mapRepetitionToLoopInfo maps the repetition
- **Then** explicit null checks are used, not `|| undefined` coercion

## Risks

- **Risk:** False positives on legitimate partial XML — **Mitigation:** Separate partialTagThreshold (2) lower than repetitionThreshold (4)
- **Risk:** Performance overhead from extra regex passes — **Mitigation:** Minimal — simple regex additions
- **Risk:** Edge cases in partial tag matching — **Mitigation:** 121 comprehensive tests
- **Risk:** Breaking changes to config — **Mitigation:** New fields are optional with backward-compatible defaults

## Links

- SPEC-0009: Original XML Repetition Detection
- ADR-0052: Enhanced detection architecture decision
- ADR-0051: Original XML repetition detection decision
- CONCEPT-0007: Unstuck Loop Detection System (updated)

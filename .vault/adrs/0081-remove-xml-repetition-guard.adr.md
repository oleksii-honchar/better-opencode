---
type: adr
id: ADR-0081
title: "Remove XML Repetition Guard from Unstuck Plugin"
status: accepted
createdAt: "2026-08-14T16:30:00Z"
updatedAt: "2026-08-14T16:30:00Z"
tags: [unstuck, loop-detection, xml-repetition, removal, simplification]
supersedes:
  - "0051-xml-repetition-detection.adr.md"
  - "0052-enhanced-xml-detection.adr.md"
superseded_by: []
see_also:
  - "0051-xml-repetition-detection.adr.md"
  - "0052-enhanced-xml-detection.adr.md"
  - "0072-per-stream-loop-detector.adr.md"
  - "0074-cross-stream-doom-loop-detection.adr.md"
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "memories/0011-unstuck-test-default-drift.memory.md"
  - "memories/0018-unstuck-trim-bug-root-cause.memory.md"
---

# ADR-0081: Remove XML Repetition Guard from Unstuck Plugin

## Context

The XML repetition guard (`enableXmlRepetitionGuard`) in the unstuck plugin was introduced in ADR-0051 to address Qwen models producing 32k+ tokens of repetitive XML tags during tool call streaming, and enhanced in ADR-0052 with partial tag detection and model-specific thresholds.

However, users report that even frontier models are becoming more sluggish and circling/looping. Investigation identified the XML repetition guard as a primary contributor:

- **Aggressive token estimation:** 1.5x multiplier triggers premature interruptions on legitimate large tool calls
- **Low partial tag threshold:** 2 partial/prefix tags triggers detection during normal tool call construction
- **Immediate intervention:** Evidence threshold of 1 means a single detection triggers stream abortion, nudge injection, and restart
- **High regex overhead:** 5 regex patterns per tool-input-delta chunk adds latency

These factors combine to cause repeated stream interruptions producing sluggishness and looping. Additional evidence: Memory 0011 documents test default drift around the xml guard; Memory 0018 documents a pruning regression that compounded false-positive impact.

## Decision

Remove the XML repetition guard entirely from the unstuck plugin.

## Rationale

1. **High false-positive rate:** Aggressive thresholds make the guard more likely to interrupt legitimate output than catch actual XML repetition.
2. **Amplified impact:** Immediate intervention (evidence threshold 1) means each false positive causes stream abortion, nudge injection, and restart — directly producing reported sluggishness.
3. **Original issue may be resolved:** The Qwen-specific issue from ADR-0051 may no longer be relevant with modern models.
4. **Simplification:** Removal reduces complexity, overhead, and configuration surface.
5. **Reversibility:** If the original issue re-emerges, detection can be reintroduced with higher thresholds and evidence threshold ≥ 2.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Adjust thresholds (increase repetition threshold, partial tag threshold, evidence threshold; reduce token multiplier) | Retains protection | Still complex; may not fully eliminate false positives; requires tuning | Removal is simpler and addresses root cause directly |
| Add diagnostic logging before removal | Verifies hypothesis | Adds temporary complexity; delays solution | Proceed with removal; add logging if issues arise |
| Disable by default | Reduces impact on most users | Still present in codebase; users who enable still affected | Removal is cleaner |
| Retain as optional feature | Preserves for specific use cases | Adds configuration and maintenance overhead | No evidence of ongoing need |

## Consequences

**Positive:**
- Elimination of false-positive interruptions from XML repetition detection
- Reduced stream processing latency (no regex overhead per tool-input-delta chunk)
- Simplified codebase and configuration
- Resolution of sluggishness and looping for affected users

**Negative:**
- Loss of protection against runaway XML repetition in tool call streaming (original ADR-0051 issue)

**Risks:**
- Qwen models may again produce runaway XML repetition. **Mitigation:** monitor logs post-removal; reintroduce detection if pattern reappears with higher thresholds and evidence threshold ≥ 2.

**Breaking changes:**
- Removal of `XmlRepetitionDetector` export from unstuck plugin API
- Removal of `xmlRepetition` from `EvidenceThresholds` interface
- Removal of XML repetition config fields from `UnstuckConfig` (enableXmlRepetitionGuard, xmlRepetitionThreshold, xmlRepetitionWindowSize, maxToolInputTokens, maxTotalToolInputTokens, modelId, modelSpecificThresholds, xmlRepetitionModelId, xmlPartialTagThreshold, xmlPartialTagDetection, xmlTokenEstimationMultiplier)
- User configs must remove corresponding XML repetition parameters

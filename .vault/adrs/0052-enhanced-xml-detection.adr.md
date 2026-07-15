---
type: adr
id: ADR-0052
title: "Enhanced XML Repetition Detection — Partial/Malformed Tag Support"
status: accepted
createdAt: "2026-07-15T15:00:00Z"
updatedAt: "2026-07-15T15:00:00Z"
tags: [unstuck, loop-detection, xml-repetition, qwen, partial-tags, bugfix]
supersedes: []
superseded_by: []
see_also:
  - "0051-xml-repetition-detection.adr.md"
  - "0016-clear-detector-history.adr.md"
  - "0017-tool-detection-gap-tolerance.adr.md"
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "specifications/0010-enhanced-xml-detection.spec.md"
---

# ADR-0052: Enhanced XML Repetition Detection — Partial/Malformed Tag Support

## Context

ADR-0051 established real-time XML repetition detection with a regex requiring complete tags:
```typescript
const XML_TAG_PATTERN = /<(\w+?)(\s[^>]*)?>.*?<\/\1>/gs
```

Research (session 260715-0853-qwen-repeating-xml) revealed two additional problems:

**Problem 1 — Malformed XML:** Qwen models produce incomplete XML:
```
{"filePath":"...</parameter>\n<parameter=oldString>
```
The complete-tag regex doesn't match partial tags, allowing repetition to continue until 32k+ tokens.

**Problem 2 — Falsy value coercion:** `mapRepetitionToLoopInfo` used `|| undefined`:
```typescript
xmlTag: repetition.tagName || undefined,           // "" → undefined (BUG)
xmlRepetitionCount: repetition.repetitionCount || undefined,  // 0 → undefined (BUG)
```
Error messages showed "undefined" instead of actual values.

**Problem 3 — Detector state persists across user messages:** The detector and evidence were created once and cached, accumulating history from previous user messages, causing false positives and stale evidence.

## Decision

Enhance `XmlRepetitionDetector` with three complementary strategies to catch all forms of XML repetition:

### 1. Additional Regex Patterns

```typescript
// Opening tags only — catches partial/malformed
const XML_OPENING_TAG_PATTERN = /<(\w+?)(\s[^>]*)?>/g

// Closing tags only — for validation
const XML_CLOSING_TAG_PATTERN = /<\/(\w+?)>/g

// Malformed patterns — catches Qwen-style repetitions
const MALFORMED_PATTERN = /\s*<\/?(\w+)\s*(?:[^>]*)?>?\s*/g
```

### 2. Prefix-Based Detection

For cases where even opening tags are incomplete, detect repeated tag name prefixes (e.g., `<parameter=oldString>` without closing).

### 3. Tag Completeness Tracking

Extended `TagEntry` with a completeness discriminator:
```typescript
interface TagEntry {
  tagName: string
  fingerprint: string
  completeness: "complete" | "partial" | "prefix"
}
```

Partial/prefix tags use a lower threshold (`partialTagThreshold: 2`) than complete tags (`repetitionThreshold: 4`).

### 4. Model-Specific Thresholds

```typescript
interface ModelSpecificThresholds {
  qwen: {
    repetitionThreshold: 3      // More sensitive than default 4
    maxToolInputTokens: 2500    // Lower limit than default 4000
    partialTagThreshold: 2      // Very sensitive
  }
}
```

### 5. Improved Token Estimation

```typescript
// XML content uses 1.5x multiplier (configurable via xmlTokenEstimationMultiplier)
private estimateTokens(text: string): number {
  const isXml = text.includes('<') && text.includes('>')
  const multiplier = this.config.xmlTokenEstimationMultiplier ?? 1.5
  return Math.ceil(text.length / 4 * (isXml ? multiplier : 1))
}
```

### 6. Bug Fix — Falsy Value Coercion

```typescript
// Before: || undefined treated "" and 0 as falsy
xmlTag: repetition.tagName !== "" ? repetition.tagName : undefined,
xmlRepetitionCount: repetition.repetitionCount > 0 ? repetition.repetitionCount : undefined,
```

### 7. Bug Fix — Detector/Evidence Reset on New User Message

```typescript
// wrapper.ts — doStream
const userMessageCount = messages.filter((m) => m.role === "user" && !(m as any)._unstuckNudge).length
if (userMessageCount > lastUserMessageCount) {
  detector.clear()
  evidence.clear()
  nudgeCount = 0
  lastUserMessageCount = userMessageCount
}
```

### 8. Configuration Enhancements

Added 4 new fields to `UnstuckConfig`:
- `xmlRepetitionModelId?: string` — model ID for model-specific thresholds
- `xmlPartialTagThreshold: number` — default: 2
- `xmlTokenEstimationMultiplier: number` — default: 1.5
- `xmlPartialTagDetection: boolean` — default: true

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Token Limit Only | Simpler | Doesn't fix root cause; still consumes tokens before interruption | Detection should catch problem earlier |
| Full XML Parser | Handles all malformed cases | Significant overhead, complex, parsing failures | Regex patterns sufficient for repetition detection |
| Model-Level Fix | Prevents at source | Doesn't help with llama.cpp; inconsistent across providers | Doesn't solve for all users |

## Consequences

- **Positive:** Catches partial tag repetition within ~500 tokens (not 32k)
- **Positive:** Model-specific optimization — Qwen users get appropriate thresholds
- **Positive:** Bug fixes eliminate undefined error values and false positives from stale detector state
- **Positive:** More accurate token estimation with XML-aware multiplier
- **Negative:** Minimal performance overhead — extra regex passes per chunk
- **Negative:** Higher false positive risk with more patterns (mitigated by separate thresholds)

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| False positives on legitimate partial XML | LOW | Separate partialTagThreshold (2), higher than prefix threshold |
| Performance degradation | LOW | Minimal overhead — simple regex additions |
| Edge cases in pattern matching | LOW | 121 comprehensive malformed XML tests |

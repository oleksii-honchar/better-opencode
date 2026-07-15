---
type: adr
id: ADR-0051
title: "Real-time XML Repetition Detection in Tool Call Streaming"
status: accepted
createdAt: "2026-07-15T09:00:00Z"
updatedAt: "2026-07-15T09:00:00Z"
tags: [unstuck, loop-detection, xml-repetition, qwen, streaming]
supersedes: []
superseded_by: []
see_also:
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "specifications/0009-xml-repetition-detection.spec.md"
  - "adrs/0016-clear-detector-history.adr.md"
  - "adrs/0017-tool-detection-gap-tolerance.adr.md"
  - "adrs/0018-alternating-pattern-detection.adr.md"
  - "adrs/0019-self-diagnosis-detection.adr.md"
---

# ADR-0051: Real-time XML Repetition Detection in Tool Call Streaming

## Context

Qwen models (qwen3.6-40b and similar) produce repeating XML `<param>` or `<function>` blocks during tool calls, generating up to 32k tokens of repetitive content before JSON parsing fails. The existing unstuck plugin detects step-level, tool-level, sentence-level, self-diagnosis, and pattern loops — but does not catch within-stream XML repetition during tool input generation.

Example from the issue:
```
Tool: read
Error: Invalid input for tool read: JSON parsing failed: Text: {"filePath":"...\n</parameter>\n<parameter=limit>\n15\n<parameter=offset>\n118\n</parameter>\n</function>\n...
```

The model repeated the same XML pattern indefinitely until token limits were hit. This is a different class of problem from step loops: it occurs within a single tool input stream.

## Decision

Implement real-time XML tag repetition detection within the existing unstuck plugin that:

1. **Monitors** tool input stream chunks for XML tag repetition patterns
2. **Interrupts** streaming when:
   - XML tag repetition threshold exceeded (default: 4 identical tags)
   - Token limit exceeded per tool call (default: 4000 tokens)
   - Total token limit exceeded across all tool calls (default: 16000 tokens)
3. **Triggers** standard nudge-and-prune recovery from the existing plugin

### Implementation Approach

- **New component**: `XmlRepetitionDetector` class — tracks token count per tool input, extracts and hashes XML tags from stream deltas, sliding window detection of tag repetition
- **Integration point**: `LoopDetectorImpl.consumeChunk()` — calls detector on `tool-input-delta` chunks, returns `LoopDetectedError` when threshold exceeded
- **Extended config**: `enableXmlRepetition`, `xmlRepetitionThreshold`, `xmlRepetitionWindowSize`, `maxToolInputTokens`, `maxTotalToolInputTokens`
- **Token counting**: Character-based estimation (1 token ≈ 4 characters) — fast enough for real-time stream processing

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Token Limit Only | Simpler, no regex parsing | Doesn't detect the *cause*; won't catch patterns within token budget | Token limits alone insufficient for early interruption |
| Complete XML Parsing | More robust, could detect malformed XML | Significant overhead, more complex, slower | Regex pattern matching sufficient for repetition detection |
| Model-level Configuration | Prevents at source | Not all providers support it; doesn't help with llama.cpp | Doesn't solve for all users, especially local llama.cpp |
| Post-generation Cleanup | No stream interruption; doesn't affect model | Wastes tokens during generation; treats symptoms, not cause | Primary goal is to *stop* excessive token consumption |

## Consequences

- **Positive:** Token savings — interrupts runaway generation early, saving 10k+ tokens per incident
- **Positive:** Faster response — stream interruption within seconds vs minutes
- **Positive:** Consistent recovery — uses existing nudge-and-prune mechanism
- **Positive:** Configurable — users can tune thresholds or disable
- **Negative:** Small performance overhead on every tool input stream (counter + hash per chunk)
- **Negative:** Risk of false positives on legitimate long tool calls (mitigated by generous limits)
- **Risk:** Interrupted tool calls may cause model to re-attempt with nudged message
- **Risk:** Detector may miss problematic patterns — token limits serve as ultimate fallback

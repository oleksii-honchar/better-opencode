---
type: adr
id: ADR-0043
title: "Select Qwen3.5-0.8B as Composition Model"
createdAt: "2026-07-11T17:55:00Z"
updatedAt: "2026-07-12T18:45:00Z"
status: accepted
tags: [tool-calling, split-model, model-selection, qwen3.5]
see_also:
  - "[[0042-intent-delegation-architecture.adr.md]]"
---

# Select Qwen3.5-0.8B as Composition Model

## Context

Need small, fast model for function call composition. Criteria:
- Sub-3B parameters for sub-100ms response
- Strong function calling accuracy
- Compatible chat template
- Works on llama.cpp

## Decision

**Qwen3.5-0.8B Q4_K_M:**

| Metric | Value |
|--------|-------|
| Parameters | 0.8B |
| Context window | 262K tokens |
| BFCL-V4 score | 25.3 |
| GGUF available | Yes |

**Deployment:** llama-swap matrix mode alongside Qwen3.6-27b

## Alternatives Considered

1. Phi-4-mini-instruct — rejected (5× larger, 4× slower)
2. Qwen3-0.6B — rejected (superseded, limited context)
3. Gemma 4 E2B — rejected (no tool calling metrics)

## Consequences

**Positive:** Sub-100ms composition, 262K context, low VRAM (~1.5 GB)
**Negative:** Newer model, community GGUF

---
type: adr
id: ADR-0029
title: "Use `:` as Variant Separator (Not `/`)"
status: accepted
createdAt: "2026-07-09T10:30:00Z"
updatedAt: "2026-07-09T10:30:00Z"
tags: [agent, model-resolution, parsing, variant, protocol]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0027-parse-model-variant-return-type.adr.md"
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "concepts/0009-agent-model-variant-parsing.concept.md"
---

# ADR-0029: Use `:` as Variant Separator (Not `/`)

## Context

The ACP already uses `/` as variant separator (`provider/model/variant`). The request asks for `:` syntax (`codex/gpt-5.5:medium`). Could support either or both.

## Decision

Support `:` as the variant separator in `parseModel`. The ACP's existing `/`-based variant extraction continues to work as a fallback in `parseModelSelection`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| `/` as singleton separator | Consistent with ACP | Ambiguous with model IDs containing `/` (e.g., `openrouter/anthropic/claude-3-opus`) | `/` is not a clean delimiter |
| Both `:` and `/` interchangeably | Flexible | Complex parsing, potential ambiguity | `:` is unambiguous |

## Consequences

- **Positive:** `:` is a clear, unambiguous separator — model IDs cannot contain `:`
- **Positive:** Backward compatible — existing `provider/model` strings unchanged
- **Positive:** ACP internal variant display remains `/`-based, avoiding client breakage
- **Neutral:** `parseModelSelection` now checks two separator formats (`:` then `/`)

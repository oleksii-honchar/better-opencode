---
type: adr
id: ADR-0028
title: "Inline `:variant` Wins Over Explicit Config Variant"
status: accepted
createdAt: "2026-07-09T10:30:00Z"
updatedAt: "2026-07-09T10:30:00Z"
tags: [agent, model-resolution, variant, precedence]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0027-parse-model-variant-return-type.adr.md"
  - "adrs/0030-models-per-entry-variant.adr.md"
  - "concepts/0009-agent-model-variant-parsing.concept.md"
---

# ADR-0028: Inline `:variant` Wins Over Explicit Config Variant

## Context

An agent config could specify both `model: codex/gpt-5.5:medium` and `variant: high`. The system needs a precedence rule.

## Decision

Inline `:variant` from the `model` string takes precedence over the explicit `variant` config field.

**Precedence order (highest to lowest):**
1. Inline `:variant` from matched `models[]` entry
2. Inline `:variant` from `model` string
3. Explicit `variant` field in agent config
4. Previously set `item.variant` (defaults, parent override, inheritance)

## Alternatives Considered

Only one approach considered — inline variant wins as the most specific configuration.

## Consequences

- **Positive:** Intuitive — users expect `model: x:medium` to use `medium` regardless of `variant` field
- **Positive:** Backward compatible — existing configs without `:variant` continue to use the `variant` field
- **Neutral:** Edge case of both fields specified now has clear resolution

---
type: adr
id: ADR-0030
title: "Propagate Per-Entry Variant for `models[]` Array"
status: accepted
createdAt: "2026-07-09T10:30:00Z"
updatedAt: "2026-07-09T10:30:00Z"
tags: [agent, model-resolution, variant, models-array]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "adrs/0028-inline-variant-precedence.adr.md"
  - "adrs/0029-colon-as-variant-separator.adr.md"
  - "concepts/0008-agent-model-selection.concept.md"
  - "concepts/0009-agent-model-variant-parsing.concept.md"
  - "specifications/0005-multi-provider-model-setup.spec.md"
  - "specifications/0006-agent-model-variant-parsing.spec.md"
---

# ADR-0030: Propagate Per-Entry Variant for `models[]` Array

## Context

The `models` field is an array of `provider/model` strings. If a user writes `codex/gpt-5.5:medium` in a `models` entry, the `:variant` should propagate to the corresponding entry so that when `resolveAgentModel` selects that entry, the variant takes effect.

## Decision

Implement per-entry variant propagation in Phase 1. The `Info.models` entry schema is extended to include `variant?: string`, and `resolveAgentModel` returns the variant alongside model info.

## Alternatives Considered

Only one approach considered — per-entry variant is the most specific way to set variant for a particular model/provider pair.

## Consequences

- **Positive:** Consistent behavior between `model` and `models` fields
- **Positive:** `models: [codex/gpt-5.5:medium]` sets variant for that specific model entry
- **Positive:** Backward compatible — existing configs without `:variant` in `models[]` work unchanged
- **Neutral:** `Info.models` entry schema gains an optional `variant` field
- **Neutral:** `resolveAgentModel` return type extends to include `variant?: string`
- **Neutral:** Caller (task.ts) needs minor update to consume the variant from resolved model

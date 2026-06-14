---
type: adr
id: ADR-0023
title: "Resolution Priority — models Before model"
status: accepted
createdAt: "2026-07-06T13:15:00Z"
updatedAt: "2026-07-06T13:15:00Z"
tags: [agent, model-resolution]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "adrs/0025-graceful-fallback.adr.md"
---

# ADR-0023: Resolution Priority — models Before model

## Context

The `models` field needs to be resolved relative to existing `model:` and `modelPreset:` fields. The priority determines which configuration takes precedence when both are defined.

## Decision

Place `models` resolution first in the priority chain:

1. `models:` list — match parent provider
2. `model:` — explicit single model
3. `modelPreset:` — suffix computation
4. Parent model — inheritance

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| `model:` before `models` | Existing field takes precedence | Defeats purpose of new feature | Newer, more specific config should win |
| `model:` + `models` merge | Both contribute to selection | Overly complex resolution logic | Ambiguous when both define models for same provider |
| Error when both defined | Prevents ambiguity | Breaks existing agents wanting `model:` fallback | Unnecessary friction; graceful fallback solves this |

## Consequences

- **Positive:** Agents with both `model:` and `models:` have clear, predictable behavior; `models:` as most targeted config wins; migration path from `model:` to `models:` is straightforward
- **Negative:** None significant — existing agents without `models:` unaffected
- **Neutral:** Falls back through increasingly general resolution paths

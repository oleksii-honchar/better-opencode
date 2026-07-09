---
type: adr
id: ADR-0027
title: "Extend `parseModel` Return Type to Include Variant"
status: accepted
createdAt: "2026-07-09T10:30:00Z"
updatedAt: "2026-07-09T10:30:00Z"
tags: [agent, model-resolution, parsing, variant]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "adrs/0028-inline-variant-precedence.adr.md"
  - "adrs/0029-colon-as-variant-separator.adr.md"
  - "concepts/0008-agent-model-selection.concept.md"
  - "concepts/0009-agent-model-variant-parsing.concept.md"
---

# ADR-0027: Extend `parseModel` Return Type to Include Variant

## Context

`Provider.parseModel` currently returns `{ providerID, modelID }`. To support `codex/gpt-5.5:medium` syntax, the variant must be extracted. Two approaches: extend return type (Option A) or create a separate wrapper function (Option B).

## Decision

Option A — extend `parseModel` return type to include an optional `variant?: string` field.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Option B: separate `parseModelWithVariant` | Backward-compatible | Duplicates logic, increases API surface, creates ambiguity | Extra complexity for no gain |
| Option C: post-processing in agent.ts only | Minimal change to parser | Fragments parsing logic, would need duplication for `ModelV2.parse` and ACP | Inconsistent, hard to maintain |

## Consequences

- **Positive:** Minimal diff, no call site breakage, consistent behavior across all consumers
- **Positive:** `ModelV2.parse` adopts same pattern for consistency
- **Neutral:** 11 call sites now have an unused `variant` field in scope (no runtime impact)
- **Neutral:** Callers that store the parsed result need minor type adjustment for typed containers

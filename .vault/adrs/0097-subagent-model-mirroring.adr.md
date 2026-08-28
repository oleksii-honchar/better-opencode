---
type: adr
id: ADR-0097
title: "Sub-agent Model Mirroring — Exact (providerID, modelID) Match"
status: accepted
createdAt: "2026-08-28T17:45:00Z"
updatedAt: "2026-08-28T17:45:00Z"
tags: [agent, model-resolution, matching, variant]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0024-exact-provider-match.adr.md"
  - "adrs/0030-models-per-entry-variant.adr.md"
  - "concepts/0008-agent-model-selection.concept.md"
---

# ADR-0097: Sub-agent Model Mirroring — Exact (providerID, modelID) Match

## Context

`resolveAgentModel` (`agent.ts`) matched a sub-agent's `models:` list by `providerID` only,
first-match-wins. With two `codex` entries configured (e.g. `gpt-5.6-luna` before
`gpt-5.6-terra`), a parent running `codex/gpt-5.6-terra:high` always spawned sub-agents on
`gpt-5.6-luna` — the parent's concrete `modelID` and `variant` were discarded.

The user directive: a sub-agent should mirror the parent's exact model when it is in its
`models:` list.

## Decision

Match the `models:` list in **two stages** (in `resolveAgentModel`, `agent.ts` ~504-544):

1. **Exact `(providerID, modelID)` match** — the first entry whose `providerID` and `modelID`
   both equal the parent's. On this match, inherit the parent's effective variant when one is
   present; otherwise keep the entry's configured variant.
2. **Provider-only match** — if no exact match exists, the first entry whose `providerID`
   equals the parent's (the previous behavior, preserved as a fallback).

`task.ts` (~193-197) passes the assistant message's effective `variant` in `parentModel`, so
the parent's variant is available for inheritance on an exact match.

This refines ADR-0024 (exact provider comparison) with a strictly more specific first stage —
still exact `===` comparison, never fuzzy matching. It is consistent with ADR-0030
(per-entry variant propagation): the entry's variant is the source of truth, except when the
parent explicitly mirrors the same model.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Config-only: reorder/unique `codex` entry | No code change | Hardcodes one winner; the other codex model can never be mirrored | Cannot satisfy the directive |
| Sentinel/inheritance flag in config | Explicit intent | New config surface for a two-line matching refinement | Breaks "list = per-provider selection" simplicity |
| Mirror variant on the provider-only fallback too | Always follow parent variant | Different modelID ⇒ different variant space; may select an invalid variant | Variant inherited on the exact match only (ADR-0030) |

## Consequences

- **Positive:** A sub-agent now mirrors the parent's exact model when it is listed — the reported bug is fixed.
- **Positive:** Backward compatible — provider-only matching (ADR-0024 / concept 0008 behavior) is preserved as stage 2.
- **Positive:** The optional `variant` on `parentModel` keeps all existing resolver call sites source-compatible.
- **Trade-off B4 (LOW):** On an exact match, the sub-agent follows the parent's variant even if the config entry specifies a different one (e.g. parent `terra:medium` → sub-agent `terra:medium`, over the config's `terra:high`). Intentional — this is the directive.
- **Trade-off B6 (LOW):** The `modelPreset` unknown-model fallback to the parent model now also inherits the parent's variant. Benign — same model, parent's own variant.
- **Neutral:** Concept 0008's "first match wins" clause is replaced with the two-stage rule.

---
type: adr
id: ADR-0025
title: "Graceful Fallback — Not Hard Error"
status: accepted
createdAt: "2026-07-06T13:15:00Z"
updatedAt: "2026-07-06T13:15:00Z"
tags: [agent, model-resolution, error-handling]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0023-resolution-priority.adr.md"
  - "adrs/0024-exact-provider-match.adr.md"
---

# ADR-0025: Graceful Fallback — Not Hard Error

## Context

When the parent provider has no match in the `models:` list, the system needs to decide how to handle the situation.

## Decision

Fall through to existing resolution chain (`model:` / `modelPreset:` / parent model) instead of throwing an error.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Hard error | Makes missing config obvious | Fails session, too strict | Breaks flexibility goal; sub-agents should work across providers |
| First entry as default | Simple fallback | Arbitrary selection, might not be appropriate | Loses the intent of provider-specific selection |
| Log warning + continue | Informs user | Adds noise; no real benefit over silent fallback | Warning fatigue; fallback is well-defined behavior |

## Consequences

- **Positive:** Agents with limited `models:` entries still work across providers; no session failures due to provider mismatches; agent developers don't need to anticipate all possible providers
- **Negative:** Potential for unexpected model selection if not carefully configured
- **Neutral:** Falls through existing, well-understood resolution chain

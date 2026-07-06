---
type: adr
id: ADR-0024
title: "Provider Match — Exact Comparison"
status: accepted
createdAt: "2026-07-06T13:15:00Z"
updatedAt: "2026-07-06T13:15:00Z"
tags: [agent, model-resolution, matching]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "adrs/0023-resolution-priority.adr.md"
---

# ADR-0024: Provider Match — Exact Comparison

## Context

The `models` list resolution needs to match entries against the parent provider ID. Different matching strategies have different trade-offs.

## Decision

Use exact `providerID === providerID` comparison. No fuzzy matching, prefix matching, or wildcard support.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Prefix matching | `mam` matches `mammoth` | Convenient for typos | Risk of accidental matches from similar provider names |
| Wildcard | `*/qwen` catches all providers | Single entry covers all | Too permissive, hard to reason about |
| Priority ordering | First entry is default | Simple | Loses provider-specific benefits entirely |

## Consequences

- **Positive:** Unambiguous results; no complex matching logic to maintain; prevents accidental matches
- **Negative:** List entries must exactly match parent provider ID; unmatched providers fall through to other resolution paths
- **Neutral:** Consistent with how Provider ID comparisons work throughout opencode

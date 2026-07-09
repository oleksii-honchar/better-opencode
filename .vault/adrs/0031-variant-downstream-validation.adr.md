---
type: adr
id: ADR-0031
title: "Validate Variant Downstream, Not in Parser"
status: accepted
createdAt: "2026-07-09T10:30:00Z"
updatedAt: "2026-07-09T10:30:00Z"
tags: [agent, model-resolution, parsing, variant, validation]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0027-parse-model-variant-return-type.adr.md"
  - "concepts/0009-agent-model-variant-parsing.concept.md"
---

# ADR-0031: Validate Variant Downstream, Not in Parser

## Context

When a variant like `codex/gpt-5.5:invalid_variant` is used, should `parseModel` validate it against available variants?

## Decision

`parseModel` performs extraction only — no validation. Variant validation happens downstream in `ProviderTransform` and prompt resolution (prompt.ts:785-790).

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Validate in `parseModel` | Catch errors early | Couples parser to provider config, breaks pure-function contract | Adds dependency injection, increases complexity |

## Consequences

- **Positive:** Parser stays pure and testable
- **Positive:** No new dependency injection needed
- **Negative:** Invalid variant strings silently ignored (fall through to default). Could add a warning log in a follow-up.

---
type: adr
id: ADR-0084
title: "Reconcile maxNudges: Default 2 (Code/Spec/Schema Aligned)"
status: accepted
createdAt: "2026-08-14T17:40:00Z"
updatedAt: "2026-08-14T19:00:00Z"
tags: [unstuck, maxnudges, config]
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "0081-remove-xml-repetition-guard.adr.md"
  - "0089-re-focus-nudge-message.adr.md"
---

# ADR-0084: Reconcile maxNudges: Default 2 (Code/Spec/Schema Aligned)

## Context

Code default `maxNudges = 10` (config.ts:83); docs spec and config schema said 2. The value was raised to 10 for the XML-repetition recovery path — which ADR-0081 removed. Each nudge = full regeneration with a growing prompt.

Verified in codebase: config.ts has `maxNudges: 2` in defaultConfig.

## Decision

Set `defaultConfig.maxNudges = 2`. Existing explicit user configs are unaffected (deep merge preserves them).

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Keep at 10 | More recovery attempts | 10 full regenerations per response is unacceptable | The reason for 10 is gone with xml_repetition removal |
| Use 5 as compromise | Safer margin | No justification for 5; doesn't match any spec | Arbitrary; 2 matches the documented contract |

## Consequences

- **Positive:** worst case drops from ~10 regenerations to 2
- **Negative:** genuine loops get fewer recovery attempts before abort

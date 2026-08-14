---
type: adr
id: ADR-0088
title: "Provider Cache Key Includes Unstuck Config Fingerprint"
status: accepted
createdAt: "2026-08-14T17:40:00Z"
updatedAt: "2026-08-14T19:00:00Z"
tags: [unstuck, provider, cache, config]
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
---

# ADR-0088: Provider Cache Key Includes Unstuck Config Fingerprint

## Context

Wrapped models were cached per `${providerID}/${modelID}` (provider.ts:1722-1723). Mid-session config changes (e.g. disabling unstuck) did NOT unwrap an already-wrapped model — the user's disable only took effect via a server restart. Findings noted the user may believe "disabled unstuck" fixed it when the restart was the actual trigger.

Verified in codebase: provider.ts imports and uses `computeUnstuckFingerprint` from the unstuck package; the cache key now includes the fingerprint; unstuck-fingerprint.test.ts has 5 passing tests.

## Decision

Append a fingerprint of the relevant unstuck config subset to the cache key (e.g. `${providerID}/${modelID}?unstuck=<hash>`). Config change → new key → fresh wrapped/unwrapped model without restart.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Clear entire model cache on config change | Simple | Drops all cached models — expensive | Too broad |
| Document that restart is required | No code change | Defeats user expectation; caused real confusion | Unacceptable UX |

## Consequences

- **Positive:** config changes apply immediately; no restart ambiguity
- **Negative:** one extra cache entry per config edit (bounded, acceptable)

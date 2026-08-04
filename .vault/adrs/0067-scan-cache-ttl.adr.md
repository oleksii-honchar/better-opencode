---
type: adr
id: ADR-0067
title: "scanCache TTL with No Caching of Empty Results"
status: accepted
createdAt: "2026-08-04T18:11:23Z"
updatedAt: "2026-08-04T18:11:23Z"
tags: [skill, dynamic-skills, cache]
supersedes: []
superseded_by: []
see_also:
  - "specifications/0013-dynamic-skill-loading-fix.spec.md"
  - "memories/0013-scan-cache-empty-poison.memory.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0067: scanCache TTL with No Caching of Empty Results

## Context

`scanCache` entries carried a `timestamp` that was never read. Empty/failed scans were cached forever, so a transient failure (`skillsCount=0`) permanently suppressed re-scanning (findings 12:36).

## Decision

Treat cache entries older than 5 minutes as stale (re-scan) and skip caching results with zero skills.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| No cache | Always fresh | Defeats O(1) repeat-scan goal | Rejected |
| Longer TTL | Less re-scan churn | Slower self-healing | Rejected — 5 min tunable |

## Consequences

- **Positive:** transient scan failures self-heal within 5 min.
- **Positive:** repeat mentions stay fast for stable dirs.
- **Negative:** re-scan of a changed dir at most every 5 min (~10-50ms, negligible).

## Verification

- TTL check `Date.now() - cached.timestamp > 300_000` at `dynamic-scanner.ts:141` — ✅ verified
- Cache set at `dynamic-scanner.ts:215` — ✅ verified

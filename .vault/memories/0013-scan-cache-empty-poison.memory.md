---
type: memory
title: "scanCache Poisoned Empty — Timestamp Never Read"
createdAt: "2026-08-04T18:11:23Z"
updatedAt: "2026-08-04T18:11:23Z"
tags: [skill, dynamic-skills, cache, gotcha]
see_also:
  - "adrs/0067-scan-cache-ttl.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: scanCache Poisoned Empty

## Fact

`scanCache` entries carried a `timestamp` that was never read. A transient failed/empty scan (`skillsCount=0`) was cached forever, permanently suppressing re-scanning of that directory for the process lifetime.

## Context

12:36 failing session `ses_0420937b0...`: `scan-for-file-complete skillsCount=0` despite the SKILL.md existing — likely this poison-empty state.

## Impact

Transient failures look like permanent "skill not found". Fixed by 5-minute TTL + skipping cache of empty results (ADR-0067). If a directory is stuck at 0 skills, check the cache entry age.

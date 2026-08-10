---
type: memory
title: "Unstuck Tests Drift from Defaults (xml guard)"
createdAt: "2026-08-01T13:22:43Z"
updatedAt: "2026-08-10T18:45:00Z"
tags: [unstuck, tests, gotcha, defaults]
see_also:
  - "specifications/0004-unstuck-loop-detection.spec.md"
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "adrs/0073-self-diagnosis-threshold-2.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: Unstuck Tests Drift from Defaults (xml guard)

## Fact

Two pre-existing unstuck test failures (present in HEAD baseline, unrelated to the 2026-08-01 doom_loop change): `enableXmlRepetitionGuard` default `false` (config.ts) vs tests expecting `true`. The earlier `selfDiagnosis: 2` default vs test-expecting-1 drift is **resolved** — ADR-0073 made `2` the authoritative threshold and tests were updated (2026-08-10).

## Context

Verified via `git show HEAD:` during the 2026-08-01 review. The unstuck suite ran 339 pass / 3 fail at that time — the 3 were baseline drift, not regressions. After the 2026-08-10 per-stream fix, the suite runs 344 pass / 2 fail — the remaining 2 are the xml guard drift.

## Impact

Blocks a fully-green unstuck suite. Out of scope for the doom_loop and per-stream-detector work; recommend a separate fix PR aligning test expectations with config defaults (align `enableXmlRepetitionGuard` default or test expectation).

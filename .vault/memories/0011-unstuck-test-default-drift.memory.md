---
type: memory
title: "Unstuck Tests Drift from Defaults (xml guard + selfDiagnosis)"
createdAt: "2026-08-01T13:22:43Z"
updatedAt: "2026-08-01T13:22:43Z"
tags: [unstuck, tests, gotcha, defaults]
see_also:
  - "specifications/0004-unstuck-loop-detection.spec.md"
  - "concepts/0007-unstuck-loop-detection.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: Unstuck Tests Drift from Defaults (xml guard + selfDiagnosis)

## Fact

Three pre-existing unstuck test failures (present in HEAD baseline, unrelated to the 2026-08-01 doom_loop change): `enableXmlRepetitionGuard` default `false` (config.ts:96) vs tests expecting `true`; `selfDiagnosis: 2` default vs test expecting met at 1.

## Context

Verified via `git show HEAD:` during the 2026-08-01 review. The unstuck suite runs 339 pass / 3 fail — these 3 are baseline drift, not regressions.

## Impact

Blocks a fully-green unstuck suite. Out of scope for the doom_loop work; recommend a separate fix PR aligning test expectations with config defaults.

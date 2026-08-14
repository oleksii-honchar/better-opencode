---
type: adr
id: ADR-0085
title: "Tighten self_diagnosis Regex and Raise Its Evidence Threshold"
status: accepted
createdAt: "2026-08-14T17:40:00Z"
updatedAt: "2026-08-14T19:00:00Z"
tags: [unstuck, self-diagnosis, regex, false-positive]
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "0073-self-diagnosis-threshold-2.adr.md"
  - "../memories/0016-self-diagnosis-regex-gap.memory.md"
---

# ADR-0085: Tighten self_diagnosis Regex and Raise Its Evidence Threshold

## Context

`detectSelfDiagnosis` matched `cannot (progress|proceed|continue)` (loop-detector.ts:17-26). "I cannot proceed because the API returned an error" is a normal status report, not a loop. Memory 0016 also documented the reverse gap ("Stuck on X" not matched).

Verified in codebase: loop-detector.ts:17-24 has the tightened patterns (removed `cannot` pattern; kept `stuck in a loop`, `i'm stuck`, `repeating the same`, `going in circles`).

## Decision

Remove `/cannot\s+(progress|proceed|continue)/i` from the patterns; keep the strong stuck-signals (`stuck in a loop`, `i'm stuck`, `repeating the same`, `going in circles`). Raise `defaultEvidenceThresholds.selfDiagnosis` from 2 → 3.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Keep `cannot` pattern, raise threshold | Keeps the signal | Still matches normal status reports at threshold 3 | The pattern is a net negative — too many false positives |
| Add "Stuck on X" pattern (memory 0016 gap) | Fills the documented gap | Out of scope for this fix; adds complexity | Defer to follow-up; focus on false-positive reduction |

## Consequences

- **Positive:** normal status reports no longer trigger self_diagnosis
- **Negative:** the "cannot proceed" stuck phrasing is no longer a detection signal (rare; other detectors still apply)

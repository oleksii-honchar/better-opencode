---
type: adr
id: ADR-0086
title: "Exclude Mandated Rule-File Reads from Doom-Loop Tracking"
status: accepted
createdAt: "2026-08-14T17:40:00Z"
updatedAt: "2026-08-14T19:00:00Z"
tags: [unstuck, doom-loop, rules, false-positive, ignore-patterns]
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "0082-evidence-gated-throw.adr.md"
---

# ADR-0086: Exclude Mandated Rule-File Reads from Doom-Loop Tracking

## Context

The always-apply rules system MANDATES reading `~/.rules/olho/always-apply/*.mdc` first (rules.mdc "Always Read First"). In the target session these identical reads were the dominant repeated pattern. Doom-loop detectors classified identical tool+input calls as loops — a legitimate mandated task pattern collided with the detector.

Verified in codebase: config.ts defines `doomLoopIgnorePatterns: ["/\\.rules\\/", "\\.mdc"]` as defaults; loop-detector.ts has `isIgnored` hook integrated into per-stream doom candidate tracking.

## Decision

Add config `doomLoopIgnorePatterns: string[]` — regex patterns matched against serialized tool input. Matching calls are excluded from doom-loop candidate tracking in BOTH the per-stream detector and the cross-stream manager. Default: `["/\\.rules\\//", "\\.mdc$"]`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Remove doom_loop for rule files entirely | Simple | Over-broad — rule files could still be part of genuine loops | Ignore patterns are surgical |
| Require input variation (different offsets) | Preserves detection | Complex; mandated reads naturally have identical offsets | Over-engineering |

## Consequences

- **Positive:** mandated rule reads no longer accumulate as doom-loop candidates
- **Negative:** a real loop that happens to re-read `.mdc` files repeatedly would be missed by doom_loop (still caught by step/tool/sentence detectors)

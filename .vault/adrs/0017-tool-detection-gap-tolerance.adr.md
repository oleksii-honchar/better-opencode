---
type: adr
title: "Add Tool-Only Detection with Gap Tolerance"
id: 2
status: accepted
createdAt: "2026-06-21T00:00:00Z"
tags: [unstuck, loop-detection, tool-detection]
see_also:
  - "0016-clear-detector-history.adr.md"
  - "0018-alternating-pattern-detection.adr.md"
---

# ADR-0017: Add Tool-Only Detection with Gap Tolerance

**ADR ID:** ADR-2
**Status:** accepted
**Date:** 2026-06-21

## Context

The tool-only detection requires N **consecutive** steps with identical tool signatures. When reasoning-only steps are interspersed with tool-call steps (e.g., alternating A→B pattern), steps with empty tool signatures break the consecutive requirement. `arraysEqual([], ["fetchurl:url=..."])` is `false`, so the check fails.

## Decision

Modify the tool-only check to filter out steps with empty `toolSignatures` before checking. Use a window of tool-bearing steps rather than consecutive steps.

## Alternatives Considered

1. Increase history window to cover enough tool-bearing steps — fragile, less precise
2. Separate tool-only and reasoning-only tracking — more complex than needed
3. No change — requires consecutive steps only — fails for alternating patterns

## Consequences

- **Positive:** Detects tool loops even when reasoning-only steps are interspersed
- **Positive:** Preserves existing false-positive protection (different tool calls still not detected)
- **Risk:** Slightly more permissive — mitigated by threshold of 6

## Verification

✅ Confirmed in `loop-detector.ts:316-341` — filters `toolSteps = this.history.filter(r => r.toolSignatures.length > 0)` before checking with `toolSteps.slice(-toolWindow)`.

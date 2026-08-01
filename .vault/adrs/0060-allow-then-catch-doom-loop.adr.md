---
type: adr
id: ADR-0060
title: "Allow-then-Catch over Deny-then-Nudge for doom_loop"
status: accepted
createdAt: "2026-08-01T13:22:43Z"
updatedAt: "2026-08-01T13:22:43Z"
tags: [unstuck, doom-loop, loop-detection, permission]
supersedes: []
superseded_by: []
see_also:
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "specifications/0012-doom-loop-nudge.spec.md"
  - "adrs/0061-dedicated-doom-loop-detection.adr.md"
  - "adrs/0062-doom-loop-permission-allow-default.adr.md"
  - "adrs/0063-no-processor-change-nudge-path.adr.md"
  - "adrs/0064-doom-loop-config-migration.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0060: Allow-then-Catch over Deny-then-Nudge for doom_loop

## Context

The doom_loop failure was a permission-layer denial (`DeniedError` escaping `processor.ts`), not an unstuck-detection failure. Unstuck wraps the model stream and never saw the denial. Two intervention points existed: (A) catch the denial in the processor and inject a nudge; (B/C) allow `doom_loop` and teach unstuck to detect the 3× same-tool-same-input pattern. The user explicitly directed Options B/C.

## Decision

Implement Allow-then-Catch: change the default `doom_loop` permission to `allow`, and add a new `doom_loop` detection type to unstuck that nudges via the existing nudge-and-prune machinery.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Option A (catch DeniedError in processor.ts) | Works even with explicit `deny` rules | Adds a second recovery path; processor must know nudge semantics | Rejected as primary; later rejected entirely (see ADR-0064) |
| Config-level fix only (`doom_loop: ask` manually) | Minimal change | Doesn't solve "nudge automatically" | Rejected |

## Consequences

- **Positive:** unstuck is the single owner of loop recovery — no duplicated recovery paths in the permission layer; reuses proven machinery (`EvidenceAccumulatorImpl`, `defaultNudgeMessage`, `pruneLoopingMessages`, `maxNudges`).
- **Negative:** users with an explicit `doom_loop: deny` rule still hit `DeniedError` until they migrate config (this user's `~/.config/opencode/agents/*.md`).
- **Neutral:** the `ask` prompt for doom_loop disappears by default; users wanting prompting can re-enable via config; detection scope is the current stream step — matches the processor's "last 3 parts" semantics.

---
type: adr
id: ADR-0089
title: "Re-Focus the Default Nudge Message"
status: accepted
createdAt: "2026-08-14T17:40:00Z"
updatedAt: "2026-08-14T19:00:00Z"
tags: [unstuck, nudge, message, re-focus]
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "0082-evidence-gated-throw.adr.md"
  - "0084-maxnudges-default-2.adr.md"
---

# ADR-0089: Re-Focus the Default Nudge Message

## Context

The default nudge ("Break out and take a different direction") pushed the model to re-plan from scratch, which is exactly the circling behavior observed. The DB session evidence showed the model re-planning the same initial task after each nudge ("Planning file reading", "Reading session.md"...).

Verified in codebase: wrapper.ts:16-31 has the updated `defaultNudgeMessage`; config `nudgeMessage` override preserved.

## Decision

Update `defaultNudgeMessage` to reference the detected context (sentence/tool) and instruct continuation from the current task state without re-reading/re-planning. Keep the config `nudgeMessage` override.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Keep generic nudge | Works for all detection types | Pushes model to re-plan — causes circling | Counter-productive |
| Per-detection-type nudge messages | Most targeted | Over-engineering; 6 detection types | Re-focus message is generic enough |

## Consequences

- **Positive:** nudges steer the model forward instead of restarting its plan
- **Negative:** the generic recovery instruction is model-dependent; custom override remains available

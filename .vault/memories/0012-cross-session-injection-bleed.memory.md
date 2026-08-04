---
type: memory
title: "Cross-Session Injection Bleed — registerDynamic is Process-Wide"
createdAt: "2026-08-04T18:11:23Z"
updatedAt: "2026-08-04T18:11:23Z"
tags: [skill, dynamic-skills, session, gotcha]
see_also:
  - "adrs/0066-per-session-injection-tracking.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: Cross-Session Injection Bleed

## Fact

`Skill.Service` state is process-wide (InstanceState keyed by directory), NOT per-session. Once any session registers a dynamic skill, later sessions in the same process get `added=0 skipped=N` and `injectDiscoveredSkills-none` — the new session's model never sees the synthetic `<available_skills>` nudge.

## Context

Failing session `ses_038341642f...` (13:24) hit this exact state because this research session had registered `better-opencode-generalist` at 13:01:53 in the same process.

## Impact

Symptom: skill "not registered / not loaded" despite discovery working. Fixed by per-session `injectedSkills` tracking in SessionMetadata (ADR-0066). Watch for `added=0 skipped=N` in dev.log when debugging dynamic skill load.

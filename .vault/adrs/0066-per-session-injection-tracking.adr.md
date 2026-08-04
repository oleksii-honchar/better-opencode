---
type: adr
id: ADR-0066
title: "Per-Session Injection Tracking in SessionMetadata"
status: accepted
createdAt: "2026-08-04T18:11:23Z"
updatedAt: "2026-08-04T18:11:23Z"
tags: [skill, dynamic-skills, session-metadata]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0055-dynamic-skill-registration.adr.md"
  - "adrs/0057-two-phase-context-injection.adr.md"
  - "specifications/0013-dynamic-skill-loading-fix.spec.md"
  - "memories/0012-cross-session-injection-bleed.memory.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0066: Per-Session Injection Tracking in SessionMetadata

## Context

The injection gate in `dynamic-scanner.ts` checked `svc.get(skill.name)` — process-wide (`skills` + `dynamicSkills`). Once any session registered a skill, later sessions in the same process got `isAlreadyRegistered=true` → nothing queued → `injectDiscoveredSkills-none`. Exact failing-session symptom: `added=0 skipped=18`, injection empty.

## Decision

Track injected skills per session in `SessionMetadata` (`injectedSkills: Set<string>` + `wasSkillInjected`/`addInjectedSkill`). Gate becomes "not a startup skill AND not injected for THIS session". Startup-skill exclusion is mandatory (failing session found 18 skills = 1 repo skill + 17 global startup skills already in the system prompt).

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Global injection-once flag | Simple | Fails for multi-session processes (the bug itself) | Rejected |
| Re-inject on every mention | Always visible | Duplicate context pollution | Rejected |

## Consequences

- **Positive:** each new session touching a repo gets the synthetic `<available_skills>` nudge for genuinely new dynamic skills.
- **Positive:** no duplicate injection within a session; startup skills never re-injected.
- **Negative:** SessionMetadata storage schema grows (backward-compatible decode default).

## Verification

- `injectedSkills` schema + methods at `packages/opencode/src/skill/session-metadata.ts:30,39,135,141` — ✅ verified
- Per-session gate at `dynamic-scanner.ts:446-466` — ✅ verified

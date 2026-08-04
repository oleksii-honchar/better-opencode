---
type: concept
title: "Dynamic Skill Visibility Chain (Registered but Invisible)"
createdAt: "2026-08-04T18:11:23Z"
updatedAt: "2026-08-04T18:11:23Z"
tags: [skill, dynamic-skills, visibility, kv-cache]
see_also:
  - "adrs/0055-dynamic-skill-registration.adr.md"
  - "adrs/0065-dynamic-skill-visibility-read-path.adr.md"
  - "adrs/0066-per-session-injection-tracking.adr.md"
  - "concepts/0010-dynamic-context-injection.concept.md"
  - "specifications/0013-dynamic-skill-loading-fix.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Concept: Dynamic Skill Visibility Chain (Registered but Invisible)

## What

The end-to-end dynamic skill pipeline (scan → register → inject) can leave a skill **registered yet invisible**: it is in `s.dynamicSkills` (process-wide) but excluded from `Skill.available()` (KV cache), invisible to the plugin's `skill_search` (indexes only the system prompt), and skipped by `registerDynamic` on later sessions (`added=0`) — so it is never injected. The only escape hatch was compaction promotion.

## Why

KV-cache preservation (ADR-0055) forbids adding dynamic skills to the system prompt before compaction. That design choice creates a visibility gap between "registered" and "searchable/injected" that is filled by:
1. **Read path** — `allIncludingDynamic()` / `getDynamicSkills` (visibility without prompt mutation).
2. **Per-session injection** — SessionMetadata tracking so each new session's model sees the nudge.
3. **Cache hygiene** — TTL + no-empty-cache so transient scan failures self-heal.

## Key Details

- Registration is process-global (register once is correct); injection must be per-session (each new model context needs the nudge). Conflating the two caused the failing session's `added=0` + empty injection.
- The plugin's `skill_search` blind spot is architectural: it reads `<available_skills>` from the system prompt, which by design never contains dynamic skills pre-compaction.
- Startup-skill exclusion in the injection gate is mandatory — re-injecting the 17 global startup skills would duplicate context.

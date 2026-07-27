---
type: adr
id: ADR-0056
title: "Core Pipeline Injection for Runtime Feature Triggers (Not Plugin Hooks)"
status: accepted
createdAt: "2026-07-18T14:10:00Z"
updatedAt: "2026-07-27T18:00:00Z"
tags: [plugin, pipeline, architecture]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0055-dynamic-skill-registration.adr.md"
  - "specifications/0011-dynamic-skill-discovery.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0056: Core Pipeline Injection for Runtime Feature Triggers (Not Plugin Hooks)

## Context

Dynamic skill scanning must reach `Skill.Service.registerDynamic()`, which is an Effect service. Plugin hooks (`Hooks`) do not have access to Effect services — they only receive `(input, output)` and mutate `output`. Therefore, a plugin-based trigger cannot call `registerDynamic()`.

This decision also establishes a pattern for any future runtime feature that needs to trigger from message/tool events and interact with Effect services.

## Decision

Wire scanning logic directly into core code at two points:
- `session/prompt.ts` — after `chat.message` hook fires, scan user message text parts for file paths
- `session/tools.ts` — after `tool.execute.after` hook fires, scan tool args for file paths

Both call `DynamicSkillScanner.scanAndRegister(filePath)` which has direct Effect service access.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Plugin hooks calling scanner | Decoupled from core | Plugins can't call Effect services; no mechanism exists to bridge | Reject: technical impossibility |
| New plugin hook `"skill.discover"` | Plugin-compatible | Over-engineering — core can call scanner directly | Reject: complexity |
| HTTP endpoint for plugin client | Full decoupling | Adds network dependency for local operation | Reject: unnecessary |

## Consequences

- **Positive:** direct, simple, no indirection
- **Positive:** scanner shares Effect scope with existing services
- **Positive:** error handling via `Effect.fork` + `Effect.catchAll` — no plugin error surface
- **Negative:** scanning behavior is in core, not configurable via plugin

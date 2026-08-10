---
type: adr
id: ADR-0070
title: "Position Config as position: \"before\" | \"after-persona\" Enum"
status: accepted
createdAt: "2026-08-10T09:58:08Z"
updatedAt: "2026-08-10T09:58:08Z"
tags: [plugin, rules-inject, config, system-prompt]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0071-rules-inject-after-persona-placement.adr.md"
  - "specifications/0014-rules-inject-position.spec.md"
  - "memories/0014-env-marker-persona-boundary.memory.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0070: Position Config as position: "before" | "after-persona" Enum

## Context

The rules-inject plugin prepends rules to `system[0]`, so rules always land BEFORE the agent persona. The user wanted an opt-in config param to inject rules AFTER the agent persona block, preserving default behavior. Two viable shapes existed: a boolean flag (`afterPersona: boolean`) or a position enum (`position: "before" | "after-persona"`).

## Decision

Add `position?: "before" | "after-persona"` (default `"before"`) to `RulesInjectConfig`, `defaultConfig`, the config schema, and the SDK types. Backward compatible — existing configs decode to default `"before"`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| `afterPersona?: boolean` (default false) | Minimal | Not extensible — ambiguous once a third position appears | Rejected: not extensible |
| Hardcode after-persona for this user | Zero config surface | Violates additive/opt-in constraint | Rejected: violates constraint |

## Consequences

- **Positive:** Backward compatible; existing configs decode to default `"before"`
- **Positive:** Future placements (e.g. "end", "after-instructions") are one-line additions without breaking configs
- **Positive:** Matches existing `Schema.Literals([...])` convention in config.ts (`share`, `compaction`)
- **Negative:** Slightly larger config surface (two tokens instead of one)

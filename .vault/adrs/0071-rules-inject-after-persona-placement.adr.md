---
type: adr
id: ADR-0071
title: "\"After Persona\" = Between Persona and Env Block, Split on Env Marker"
status: accepted
createdAt: "2026-08-10T09:58:08Z"
updatedAt: "2026-08-10T09:58:08Z"
tags: [plugin, rules-inject, system-prompt, env-marker]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0070-rules-inject-position-config.adr.md"
  - "specifications/0014-rules-inject-position.spec.md"
  - "concepts/0002-system-prompt.concept.md"
  - "memories/0014-env-marker-persona-boundary.memory.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0071: "After Persona" = Between Persona and Env Block, Split on Env Marker

## Context

The transform hook receives `output.system` as a one-element string array; it does NOT receive `agent.prompt` separately (only `input.agent.name`, request.ts:70). `system[0]` is composed as `[agent.prompt ?? provider_default, ...input.system, ...user.system].join("\n")`. The env block — always starting with the deterministic string `"You are powered by the model named ..."` (session/system.ts:55) — is the first element of `input.system`, so it reliably follows the persona in the main chat path.

## Decision

When `position === "after-persona"`, split `system[0]` at the first occurrence of the env marker `"You are powered by the model named"` and insert `rules + "\n\n"` before it. If the marker is not found, fall back to prepend (current behavior) with a debug log.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Reconstruct persona prefix from agent config | No magic string | Fragile, tightly coupled to prompt-resolution logic | Rejected: coupling |
| Append to end of `system[0]` | Simple | Not the literal reading of "after agent persona block"; env/instructions/skills still precede rules | Rejected: wrong semantics |
| Track persona via agent name | No string split | Hook doesn't provide prompt text | Rejected: unavailable |

## Consequences

- **Positive:** Rules land immediately after persona, before env/instructions/skills
- **Positive:** Default "before" path byte-for-byte unchanged
- **Negative:** Relies on magic string from `session/system.ts`; if env block prefix ever changes, placement silently reverts to prepend. Mitigation: debug log on fallback; marker is deterministic and tested

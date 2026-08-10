---
type: memory
title: "Env-Block Marker \"You are powered by the model named\" is the Deterministic Persona Boundary"
createdAt: "2026-08-10T09:58:08Z"
updatedAt: "2026-08-10T09:58:08Z"
tags: [system-prompt, env-marker, plugin, gotcha]
see_also:
  - "concepts/0002-system-prompt.concept.md"
  - "adrs/0071-rules-inject-after-persona-placement.adr.md"
---

# Memory: Env-Block Marker is the Deterministic Persona Boundary

## Fact

In the main chat path, `system[0]` is one joined string: `[agent.prompt ?? provider_default, ...input.system, ...user.system].join("\n")`. The env block always starts with the deterministic string `"You are powered by the model named ..."` (session/system.ts:55) and is the first element of `input.system` — so it reliably follows the persona.

## Context

The `experimental.chat.system.transform` hook receives only `output.system: string[]` — NOT `agent.prompt` separately (only `input.agent.name`). Any plugin that needs to manipulate the persona boundary must use the env marker as its anchor.

## Impact

- Deterministic anchor for "after persona" placement in system-prompt-manipulating plugins (rules-inject uses this)
- If the env-block prefix ever changes, placement logic that splits on the marker silently reverts to fallback (prepend in rules-inject) — debug log mitigates

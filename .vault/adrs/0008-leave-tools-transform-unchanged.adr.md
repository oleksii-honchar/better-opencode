---
type: adr
id: ADR-0008
title: "metaSkillEnabled — Leave toolsTransform Unchanged"
status: accepted
createdAt: "2026-06-14T12:46:00Z"
updatedAt: "2026-06-14T12:46:00Z"
tags: [agent-meta-tool, plugin, tools, scope]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0007-always-extract-skills.adr.md"
  - "concepts/0005-agent-meta-tool-plugin.concept.md"
  - "specifications/0002-meta-skill-enabled-switch.spec.md"
---

# ADR-0008: metaSkillEnabled — Leave toolsTransform Unchanged

## Context

The `toolsTransform` hook passes the `skill` tool through with a trimmed description and adds meta tools (`tool_search`, `tool_use`, `skill_search`). A question arose: should `toolsTransform` also skip when `metaSkillEnabled = false`?

## Decision

**No change to `toolsTransform`.** Meta tools are always registered. The `skill` tool is always passed through. This is consistent with the requirement: "when this meta skill enabled equals false, it means that we leave skills as it is loaded and processed and present in the system prompt."

The user wants skills to appear in the system prompt as standard — they did not ask to change tool registration.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| **Leave unchanged (selected)** | Simplest, matches user intent | Meta tools always present | User explicitly wants meta tools to remain |
| Skip meta tool addition when disabled | Clean "no meta" mode | Contradicts user requirement | toolsTransform controls tool discovery, not skill processing |
| Only skip skill tool description trim | Minor optimization | Unnecessary complexity | Adds no value |

## Consequences

- **Positive:** `toolsTransform` and its tests require zero changes.
- **Positive:** Meta tools are available regardless of the switch setting.
- **Positive:** No behavioral split in the tools layer — one less dimension to test.

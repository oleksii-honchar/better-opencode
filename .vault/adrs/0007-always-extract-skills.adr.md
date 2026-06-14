---
type: adr
id: ADR-0007
title: "metaSkillEnabled — Always Extract Skills to MetaState"
status: accepted
createdAt: "2026-06-14T12:46:00Z"
updatedAt: "2026-06-14T12:46:00Z"
tags: [agent-meta-tool, plugin, skills, skill-search]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0008-leave-tools-transform-unchanged.adr.md"
  - "concepts/0005-agent-meta-tool-plugin.concept.md"
  - "specifications/0002-meta-skill-enabled-switch.spec.md"
---

# ADR-0007: metaSkillEnabled — Always Extract Skills to MetaState

## Context

The `@olho/agent-meta-tool` plugin has a `metaSkillEnabled` switch that controls whether skill content in the system prompt is replaced. The `skill_search` meta tool reads from `metaState.skills` to return results. If the system transform is skipped entirely when `metaSkillEnabled = false`, `metaState.skills` is never populated and `skill_search` produces empty results.

## Decision

The `extractSkills()` step always runs in the system transform handler, regardless of the `metaSkillEnabled` flag. Only the replacement step (replacing `<available_skills>` with `<amt-system-reminder>`) is conditional.

```
// Always runs:
const skills = extractSkills(match[0])
metaState.skills = skills

// Conditional:
if (metaSkillEnabled) {
  output.system[i] = segment.replace(match[0], buildReplacement(skills))
}
```

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| **Always extract (selected)** | skill_search works in both modes | Small overhead (~8 regex matches) | Best balance of simplicity and correctness |
| Skip entirely when disabled | Zero extra work | skill_search needs alternative data source | Breaks skill_search when disabled |
| Extract separately in metaState init | Clean separation | Duplicate parsing logic | Unnecessary complexity |

## Consequences

- **Positive:** `skill_search` is fully functional in both enabled and disabled modes.
- **Positive:** Simple, transparent logic — one branching point in the handler.
- **Negative:** Minimal overhead of always running `extractSkills()` even when disabled (~8 regex exec calls per system prompt segment).

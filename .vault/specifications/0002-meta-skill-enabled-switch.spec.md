---
type: specification
title: "metaSkillEnabled Switch for AgentMetaTool"
kind: feature
status: completed
createdAt: "2026-06-14T12:46:00Z"
updatedAt: "2026-06-14T13:06:00Z"
tags: [agent-meta-tool, plugin, configuration, skills]
owner: ""
target: "2026-06-14"
see_also:
  - "adrs/0007-always-extract-skills.adr.md"
  - "adrs/0008-leave-tools-transform-unchanged.adr.md"
  - "concepts/0005-agent-meta-tool-plugin.concept.md"
---

# Specification: metaSkillEnabled Switch for AgentMetaTool

## Overview

Add a `metaSkillEnabled` boolean configuration switch to the `@olho/agent-meta-tool` plugin that controls whether the meta-layer replaces skill content in the system prompt. When disabled, skills remain in the system prompt exactly as standard (no replacement by `<amt-system-reminder>`), while meta tools (`meta_search`, `meta_use`, `skill_search`) continue to function normally.

### Behavior Summary

| Mode | System Prompt | metaState.skills | Meta Tools | Backward Compat |
|------|---------------|-------------------|------------|-----------------|
| `metaSkillEnabled: true` (default) | `<available_skills>` replaced by `<amt-system-reminder>` | Populated | All 3 work | Identical to current |
| `metaSkillEnabled: false` | `<available_skills>` left intact | Populated | All 3 work | Plugin activates but leaves skill block alone |

## Key Interfaces

### Plugin Configuration (opencode.json)

```jsonc
// Current (still works):
"plugin": ["@olho/agent-meta-tool"]

// Disable skill processing:
"plugin": [["@olho/agent-meta-tool", { "metaSkillEnabled": false }]]
```

### Modified Files

| File | Change |
|------|--------|
| `src/types.ts` | Added `MetaToolPluginOptions` interface with `metaSkillEnabled?: boolean` |
| `src/hooks/system-transform.ts` | Refactored `systemTransform` → `createSystemTransform(metaSkillEnabled)` factory + backward-compat default export |
| `src/index.ts` | Accept options, destructure `metaSkillEnabled` (default `true`) |

### Key Invariants

- **`extractSkills()` always runs** → `metaState.skills` always populated
- **`buildReplacement()` only runs when `metaSkillEnabled = true`**
- **`output.system` mutated only when `metaSkillEnabled = true`**
- **`toolsTransform` unchanged** — meta tools always registered

## Files Modified

| File | Location |
|------|----------|
| `src/types.ts` | `/Users/oleksii.honchar/www/misc/agent-meta-tool/src/types.ts` |
| `src/hooks/system-transform.ts` | `/Users/oleksii.honchar/www/misc/agent-meta-tool/src/hooks/system-transform.ts` |
| `src/index.ts` | `/Users/oleksii.honchar/www/misc/agent-meta-tool/src/index.ts` |
| `src/hooks/system-transform.test.ts` | `/Users/oleksii.honchar/www/misc/agent-meta-tool/src/hooks/system-transform.test.ts` |

## Verification

- **Tests:** 121/121 pass (5 new test cases for disabled mode)
- **Typecheck:** Zero errors
- **Build:** dist/ generated
- **Backward compat:** 16 existing `systemTransform` call sites unchanged

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking test imports if `systemTransform` removed | Keep `systemTransform` as default-constructed export |
| `skill_search` returning empty if metaState.skills not populated | `extractSkills()` always runs in both modes |
| User confusion about mode differences | Document in plugin README and opencode.json schema |

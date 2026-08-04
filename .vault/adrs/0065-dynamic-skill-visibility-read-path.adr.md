---
type: adr
id: ADR-0065
title: "Read-Only Visibility Path for Dynamic Skills (allIncludingDynamic)"
status: accepted
createdAt: "2026-08-04T18:11:23Z"
updatedAt: "2026-08-04T18:11:23Z"
tags: [skill, dynamic-skills, kv-cache, plugin]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0055-dynamic-skill-registration.adr.md"
  - "specifications/0011-dynamic-skill-discovery.spec.md"
  - "specifications/0013-dynamic-skill-loading-fix.spec.md"
  - "concepts/0010-dynamic-context-injection.concept.md"
  - "concepts/0011-dynamic-skill-visibility.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0065: Read-Only Visibility Path for Dynamic Skills (allIncludingDynamic)

## Context

Dynamic skills are registered into `Skill.Service.dynamicSkills`, but `available()` returns startup-only to preserve the KV cache (ADR-0055). The plugin's `skill_search` only sees system-prompt skills, so registered dynamic skills are invisible — the failing session logged `added=0 skipped=18` and empty search. Recommendation #3 ("promote on first registration") was rejected: it would change the system prompt mid-conversation and invalidate the KV cache.

## Decision

Keep promotion compaction-only (per ADR-0055). Add a read-only `Skill.Service.allIncludingDynamic()` (`packages/opencode/src/skill/index.ts`) returning startup + dynamic skills, and expose it to plugins via a `getDynamicSkills` function on PluginInput (Effect bridge, `packages/opencode/src/plugin/index.ts`). `available()` and `all()` are untouched — the system prompt stays byte-identical pre-compaction.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Promote on first registration | Immediate visibility | Breaks KV cache (system prompt changes mid-conversation) | Rejected — invalidates the ADR-0055 guarantee |
| Inject dynamic skills into system prompt each build | Simple | Same KV cache failure | Rejected |

## Consequences

- **Positive:** skill_search sees dynamic skills without waiting for compaction.
- **Positive:** KV cache guarantee intact; `available()`/`all()` consumers untouched.
- **Positive:** additive API — no consumer regressions.
- **Negative:** one extra function call on first skill_search per session (cheap, no HTTP).

## Verification

- `allIncludingDynamic()` present at `packages/opencode/src/skill/index.ts:102,309,360` — ✅ verified
- `getDynamicSkills` PluginInput wiring at `packages/opencode/src/plugin/index.ts:231-239` — ✅ verified

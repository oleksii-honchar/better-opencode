---
type: adr
id: ADR-0055
title: "Register Dynamic Skills in Skill.Service via Separate Storage"
status: accepted
createdAt: "2026-07-18T14:10:00Z"
updatedAt: "2026-07-27T18:00:00Z"
tags: [skill, kv-cache, architecture]
supersedes: []
superseded_by: []
see_also:
  - "concepts/0010-dynamic-context-injection.concept.md"
  - "specifications/0011-dynamic-skill-discovery.spec.md"
  - "adrs/0065-dynamic-skill-visibility-read-path.adr.md"
  - "adrs/0066-per-session-injection-tracking.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0055: Register Dynamic Skills in Skill.Service via Separate Storage

## Context

Project-scoped skills (`.agents/skills/`, `.opencode/skills/`) are discovered once at opencode startup. When a user references a file from a different repo, that repo's skills are never loaded. To fix this, skills must be dynamically discovered at runtime.

The critical constraint: if dynamically discovered skills immediately appear in `Skill.Service.available()`, the system prompt changes every turn → KV cache invalidated → entire context reprocessed (e.g., 60k → 63k tokens reprocessed each turn). This is unacceptable for performance.

## Decision

Add `registerDynamic()` and `promoteDynamicToStartup()` methods to `Skill.Service` with a separate `dynamicSkills: Record<string, Info>` storage. The `available()` method returns **ONLY startup skills** until compaction occurs. After compaction, `promoteDynamicToStartup()` moves dynamic skills into the startup `skills` record.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Store in plugin state only | Isolated from core | skill tool and SystemPrompt need new access paths; fragmented state | Reject: fragmentation |
| Mutate existing `skills` Record | Simple | Could corrupt startup-discovered state; no separation of concerns | Reject: side effects |
| Store in metaState only (agent-meta-tool) | Works with meta tool | Creates hard dependency on agent-meta-tool | Reject: coupling |
| Merge dynamic into `available()` immediately | Skills immediately searchable | Breaks KV cache — system prompt changes every turn → full context reprocessed | Reject: performance |

## Consequences

- **Positive:** KV cache preserved before compaction (system prompt identical every turn)
- **Positive:** minimal core change (additive, doesn't touch startup paths)
- **Positive:** works regardless of agent-meta-tool presence
- **Negative:** dynamic skills not in the system prompt until post-compaction promotion (they are visible via conversation context in the meantime)
- **Negative (mitigated):** dynamic skills were not searchable via `skill_search` pre-compaction — resolved by the read-only visibility path in ADR-0065

---
type: specification
kind: feature
title: "Dynamic Skill Discovery on File Mention"
status: completed
createdAt: "2026-07-18T14:10:00Z"
updatedAt: "2026-07-27T18:00:00Z"
tags: [skill, plugin, kv-cache]
see_also:
  - "adrs/0055-dynamic-skill-registration.adr.md"
  - "adrs/0056-core-pipeline-injection.adr.md"
  - "adrs/0057-two-phase-context-injection.adr.md"
  - "adrs/0058-self-inject-pattern.adr.md"
  - "adrs/0059-synchronous-scan-decision.adr.md"
  - "concepts/0010-dynamic-context-injection.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Specification: Dynamic Skill Discovery on File Mention

## Goal

Dynamically discover and inject project-scoped skills when the user references a file from a different repo — without breaking KV cache or startup-time skill discovery.

**Problem:** Project-scoped skills (`.agents/skills/`, `.opencode/skills/`) are only discovered once at opencode startup, scoped to the current project directory. When a user references a file from a different repo, that repo's skills are never loaded.

**Solution:** File-mention-triggered scanning with two-phase injection: synthetic messages for immediate visibility (pre-compaction), system prompt promotion for persistence (post-compaction). Scan runs synchronously with self-inject pattern.

## Architecture

```mermaid
flowchart TD
    subgraph "Trigger Points"
        PM[User message with file path] --> SCAN[DynamicSkillScanner]
        TM[Tool execution with file arg] --> SCAN
    end

    subgraph "Scanner (synchronous)"
        SCAN --> WALK[Walk up for .agents/]
        WALK --> CACHE{Cached?}
        CACHE -->|no| GLOB[Glob SKILL.md files]
        CACHE -->|yes| RETURN
        GLOB --> RETURN[Return Info[]]
    end

    subgraph "Registration"
        RETURN --> REG[Skill.Service.registerDynamic]
        REG --> DYN[dynamicSkills record]
    end

    subgraph "Self-Inject"
        DYN --> FORMAT[Format skills as XML]
        FORMAT --> SYNTH[Synthetic user message via flushInjectedMessages]
        SYNTH --> VIS1[Visible in conversation context]
    end

    subgraph "Phase 2: Post-Compaction"
        COMP[Compaction completes] --> PROMO[Skill.Service.promoteDynamicToStartup]
        PROMO --> SYS[Skills in system prompt via available()]
        SYS --> VIS2[Visible in system prompt + skill_search]
    end
```

## Components

1. **Skill.Service Extension** — `registerDynamic()`, `promoteDynamicToStartup()`, separate `dynamicSkills` storage. `available()` returns only startup skills until compaction.

2. **DynamicSkillScanner** — `findAgentsDirectories()` (walk-up), `scanAgentsSkills()` (glob + parse), in-memory cache by folder path. Self-injects after registration.

3. **Pipeline Integration** — Triggers in `prompt.ts` (user message) and `tools.ts` (tool execution), synchronous (no fork), Effect.ignore for graceful error handling.

4. **Session Metadata** — `dynamicSkillsScanned` (deduplication), `dynamicSkillsRegistered` (compaction survival).

5. **Logging** — All operations tagged with `tag: "dynamic-skills"`.

## Phases

| Phase | Status |
|-------|--------|
| Phase 1: Skill Service Extension | ✅ Completed |
| Phase 2: Dynamic Skill Scanner | ✅ Completed |
| Phase 3: Pipeline Integration & Session Metadata | ✅ Completed |
| Phase 4: Integration & Documentation | ✅ Completed |
| Phase 5: Fix injection + race condition (self-inject) | ✅ Completed |
| Phase 6: Fix hang (synchronous scan) | ✅ Completed |

## Acceptance Criteria

- ✅ When user mentions a file from a repo, that repo's skills are discovered
- ✅ Skills are injected into conversation context (synthetic message for immediate visibility)
- ✅ No duplicate injection of already-available skills
- ✅ Works with `@olho/agent-meta-tool` plugin (metaState.skills updated post-compaction)
- ✅ Startup-time discovery unchanged (backward-compatible)
- ✅ KV cache preserved (system prompt stable until compaction)
- ✅ Dynamic discovery verified working (owui-filter skill discovered in live test)

## Implementation Files

- `packages/opencode/src/skill/index.ts` — Skill.Service extension
- `packages/opencode/src/skill/dynamic-scanner.ts` — Scanner module with self-inject (new)
- `packages/opencode/src/skill/session-metadata.ts` — Session metadata (new)
- `packages/opencode/src/session/prompt.ts` — Message pipeline trigger (synchronous)
- `packages/opencode/src/session/tools.ts` — Tool execution trigger (synchronous)
- `packages/opencode/src/session/compaction.ts` — Post-compaction promotion

## Test Results

132 tests passing, 0 failures. Reviewer approved.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Folder scanning slow on first mention | Cache per folder path; first mention ~10-50ms, subsequent O(1); synchronous but fast |
| Symlink loop in path resolution | Depth limit of 50 on directory walk; realpathSync resolves symlinks |
| Scanning error blocks pipeline | All scan calls wrapped in Effect.ignore — graceful degradation |
| Context window: too many skills injected | Only skills from referenced repos; typically 1-5 per repo |
| Forked scan hangs on I/O | RESOLVED: removed fork, scan is synchronous |
| Race condition between scan and inject | RESOLVED: self-inject pattern in same Effect context |

## Open Decisions

1. **Should bash tool execution be scanned for file paths?** — Skipped for now (high false positive rate); can be added as enhancement.
2. **Should `apply_patch` tool args be parsed for file paths?** — Deferred to v2 (requires patch text parsing).

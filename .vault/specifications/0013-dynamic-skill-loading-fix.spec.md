---
type: specification
kind: feature
title: "Dynamic Skill Loading Fix — Visibility, Per-Session Injection, Cache TTL"
status: implemented
createdAt: "2026-08-04T18:11:23Z"
updatedAt: "2026-08-04T18:11:23Z"
tags: [skill, dynamic-skills, plugin, kv-cache]
see_also:
  - "adrs/0055-dynamic-skill-registration.adr.md"
  - "adrs/0065-dynamic-skill-visibility-read-path.adr.md"
  - "adrs/0066-per-session-injection-tracking.adr.md"
  - "adrs/0067-scan-cache-ttl.adr.md"
  - "adrs/0068-scan-tool-args-mcp-extension.adr.md"
  - "specifications/0011-dynamic-skill-discovery.spec.md"
  - "concepts/0010-dynamic-context-injection.concept.md"
  - "concepts/0011-dynamic-skill-visibility.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Specification: Dynamic Skill Loading Fix

## Goal

Fix the dynamic skill loading visibility hole: a skill registered in `s.dynamicSkills` (process-wide) is excluded from `available()`, invisible to the plugin's `skill_search`, and skipped by `registerDynamic` on subsequent sessions. Failing session `ses_038341642f...` logged `added=0 skipped=18`, `injectDiscoveredSkills-none`, empty `skill_search`.

## Scope

- **In:** skill visibility read path, per-session injection, scanCache TTL, scanToolArgs MCP extension, plugin skill_search merge.
- **Out (user directive):** workspaceFolders topic — to be deprecated later.

## Components

1. **Skill.Service.allIncludingDynamic()** — read-only union of startup + dynamic; `available()`/`all()` untouched (KV cache preserved).
2. **PluginInput.getDynamicSkills** — Effect bridge to `allIncludingDynamic` (no HTTP).
3. **SessionMetadata.injectedSkills** — per-session injection dedupe + startup-skill exclusion.
4. **scanCache TTL** — 5-minute staleness + no caching of empty results.
5. **scanToolArgs MCP extension** — path-keyed string arg scan for unknown tools.
6. **Plugin skill_search merge** (agent-meta-tool) — startup + dynamic, dedupe dynamic wins.

## Implementation Phases

| Phase | Work | Status |
|-------|------|--------|
| P1 | `allIncludingDynamic()` + test | ✅ Implemented |
| P3 | SessionMetadata `injectedSkills` + methods + decode default | ✅ Implemented |
| P4 | dynamic-scanner per-session gate (scanParts + scanToolArgs) | ✅ Implemented |
| P5 | scanCache TTL + no-empty-cache | ✅ Implemented |
| P6 | scanToolArgs MCP arg scan | ✅ Implemented |
| P7 | Plugin: store getDynamicSkills, skill_search merge + tests | ✅ Implemented |
| P8 | Docs / FEATURES.md | ✅ Implemented (docs modified in repo) |

## Acceptance Criteria

- ✅ A new session mentioning the repo file injects the synthetic `<available_skills>` nudge for genuinely new dynamic skills (fixes `injectDiscoveredSkills-none`).
- ✅ `skill_search` returns the dynamic skill (fixes blind search).
- ✅ System prompt byte-identical pre-compaction (KV cache preserved).
- ✅ Transient scan failures self-heal within 5 min.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| KV cache break if `available()` changes | `available()`/`all()` untouched; additive only |
| Plugin fetch latency | In-process bridge; no HTTP; error → startup-only fallback |
| SessionMetadata old data without `injectedSkills` | Decode default to empty set |
| Duplicate injection | `injectedSkills` per-session dedupe + startup exclusion |
| MCP arg scan false positives | Path-keyed args first; parent-dir existence check bounds cost |

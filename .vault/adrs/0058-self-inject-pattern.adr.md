---
type: adr
id: ADR-0058
title: "Self-Inject Pattern for Dynamic Skill Discovery (Eliminates Call-Site Injection)"
status: accepted
createdAt: "2026-07-27T18:00:00Z"
updatedAt: "2026-07-27T18:00:00Z"
tags: [skill, pattern, race-condition]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0055-dynamic-skill-registration.adr.md"
  - "adrs/0056-core-pipeline-injection.adr.md"
  - "specifications/0011-dynamic-skill-discovery.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0058: Self-Inject Pattern for Dynamic Skill Discovery

## Context

Two blocking defects were discovered after initial implementation:

1. **Missing injection in `prompt.ts`:** The integration wired scanning (`scanParts`) but never called `injectDiscoveredSkills` — skills were queued but never flushed as synthetic messages.
2. **Race condition in `tools.ts`:** `injectDiscoveredSkills` was called after the forked `scanToolArgs` but BEFORE the scan completed — the queue was empty, so nothing injected.

Both defects resulted in the same symptom: dynamic skill discovery appeared to work (scan triggered, skills found) but skills were never visible to the model.

## Decision

Move injection logic INTO the scan functions (`scanParts`, `scanToolArgs`). Each scan function now self-injects: it registers skills to the queue, calls `injectDiscoveredSkills` internally, and flushes synthetic messages — all within the same Effect context. Callers no longer need to remember to inject.

**Before (caller responsibility):**
```typescript
// prompt.ts — forgot to call inject
yield* DynamicSkillScanner.scanParts(...).pipe(Effect.forkChild, Effect.ignore)
// ❌ no injectDiscoveredSkills call

// tools.ts — called too early (race)
yield* DynamicSkillScanner.scanToolArgs(...).pipe(Effect.forkChild)
const result = yield* DynamicSkillScanner.injectDiscoveredSkills(sessionID)
// ❌ executes BEFORE forked scan completes
```

**After (self-inject):**
```typescript
// dynamic-scanner.ts — inside scanParts/scanToolArgs
const skills = yield* scanAndRegister(...)
const injectResult = yield* injectDiscoveredSkills(sessionID)
if (injectResult.injected > 0 && injectResult.xml) {
  yield* flushInjectedMessages({ injected: [{ role: "user", text: injectResult.xml }], ... })
}
// ✅ injection happens after registration in same Effect context

// prompt.ts — simple call, no injection knowledge needed
yield* DynamicSkillScanner.scanParts(...).pipe(Effect.forkChild, Effect.ignore)
```

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Keep caller responsibility, fix `prompt.ts` | Minimal change | Doesn't fix race condition; fragile pattern (callers can forget) | Reject: fragile |
| Make scan synchronous (remove fork) | Race-free | Blocks message processing; defeats non-blocking design goal | Reject: performance |
| Use Effect.promise/await for scan completion | Race-free | Complex; couples caller to scan internals | Reject: complexity |

## Consequences

- **Positive:** Eliminates both bugs (missing injection + race condition)
- **Positive:** Simpler call sites — callers only trigger scan, don't manage injection lifecycle
- **Positive:** Injection timing is deterministic (always after registration completes)
- **Negative:** `flushInjectedMessages` duplicated in `dynamic-scanner.ts` (acceptable — avoids circular dependency with tools.ts)
- **Negative:** Scan functions now have more responsibility (scan + inject), but still cohesive (all dynamic-skill-related)

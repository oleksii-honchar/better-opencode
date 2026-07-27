---
type: adr
id: ADR-0059
title: "Synchronous Scan for Dynamic Skill Discovery (Removed Fork and Timeout)"
status: accepted
createdAt: "2026-07-27T18:00:00Z"
updatedAt: "2026-07-27T18:00:00Z"
tags: [skill, fork, hang, race-condition, synchronous]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0056-core-pipeline-injection.adr.md"
  - "adrs/0058-self-inject-pattern.adr.md"
  - "specifications/0011-dynamic-skill-discovery.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0059: Synchronous Scan for Dynamic Skill Discovery

## Context

The dynamic skill scan had two critical issues when forked (`Effect.forkChild`):

1. **Hangs:** No timeout on forked effect + async I/O (`AppFileSystem.Service`) = indefinite hang. Symptoms: `trigger-prompt` log appears, then silence — no skills discovered.
2. **Race condition:** Forked scan completed asynchronously; callers couldn't reliably know when it finished. Self-inject pattern was added to address this, but the underlying race remained.

**Timeline:**
- Initial design: forked scan for non-blocking performance
- Bug 1 found: forked scan hung on `AppFileSystem.Service.isDir()`
- Fix attempt: added self-inject pattern (ADR-0058) + considered timeouts
- Decision: timeouts are band-aids; removing the fork entirely is simpler and more reliable

## Decision

Remove `Effect.forkChild` — make `scanParts` and `scanToolArgs` synchronous. The scan runs in the main pipeline flow, blocking briefly (~10-50ms) while skills are discovered and injected.

**Before (forked + complex):**
```typescript
yield* DynamicSkillScanner.scanParts(...).pipe(
  Effect.timeout(3000),
  Effect.forkChild,
  Effect.ignore,
)
```

**After (synchronous + simple):**
```typescript
yield* DynamicSkillScanner.scanParts(...).pipe(Effect.ignore)
```

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Fork + timeouts (3s/2s/1s levels) | Non-blocking, no hangs | Complex (3 timeout levels); timeouts are band-aids; self-inject already required | Reject: over-engineered |
| Fork + self-inject only (no timeout) | Simpler | Still can hang indefinitely | Reject: hangs unresolved |
| Remove fork, make synchronous | Simple, race-free, hang-free | Blocks message processing briefly (~10-50ms) | Accept: blocking is negligible |

## Consequences

- **Positive:** No more hangs — synchronous effects always complete or throw
- **Positive:** No race conditions — scan completes before pipeline continues
- **Positive:** No timeout tuning needed — simpler, more predictable
- **Positive:** Self-inject pattern (ADR-0058) works deterministically — injection happens in same synchronous context
- **Negative:** Message processing blocked for scan duration — acceptable (10-50ms for filesystem scan is imperceptible)
- **Negative:** Loses "non-blocking" design goal from original spec — trade-off accepted for reliability

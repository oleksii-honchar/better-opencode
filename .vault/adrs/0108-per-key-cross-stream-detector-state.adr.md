---
type: decision
id: DEC-0108
title: "Per-(session, tool, fingerprint) Cross-Stream Detector State + Default On"
status: proposed
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [unstuck, doom-loop, cross-stream, incident, 2026-10-03]
system: opencode
supersedes: []
superseded_by: []
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "0074-cross-stream-doom-loop-detection.adr.md"
  - "0072-per-stream-loop-detector.adr.md"
  - "0082-evidence-gated-throw.adr.md"
  - "0084-maxnudges-default-2.adr.md"
  - "0087-cross-stream-opt-in.adr.md"
  - "../memories/0015-cross-stream-detection-gap.memory.md"
  - "../specifications/0024-runaway-loop-hardening.spec.md"
---

# DEC-0108: Per-(session, tool, fingerprint) Cross-Stream Detector State + Default On

> **Status note:** implemented on branch `261003-fix-runaway-loop-hardening` (staged,
> not yet committed/merged as of 2026-10-04). Flip to `accepted` after merge into
> `patched/dev2`.

## Context

`CrossStreamDoomLoopManagerImpl` kept ONE run-state per session
(`cross-stream-doom-loop.ts:27`); interleaved A-B-A-B calls reset the count. The
2026-10-03 incident loop (`getPersonaEntryNode` ×623 alternating with `recallMemory`
×627, 163.7M tokens burned) sat in this blind spot even with detection enabled.
ADR-0087 downgraded cross-stream detection to opt-in *because* this fix was deferred.

## Decision

Replace single run-state with a keyed count map (`session\0tool\0fingerprint`),
a session-key index for `resetSession`, and a per-session cap of 64 keys
(oldest-inserted evicted). Flip `enableCrossStreamDoomLoopDetection` default to `true`.
Verified in code: NUL-joined key map + `sessionKeys` index, eviction tests,
`config.ts` default `true` with incident-citing comment.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| Keep single state | Provably misses the incident shape (alternating tools) |
| Tool-frequency without input fingerprint | False positives on legitimate repeated reads/greps |
| Time-decayed windows | Deferred — cap + eviction suffice |

## Consequences

- Supersedes ADR-0087's deferral rationale — its rejected alternative (per-key state) is now implemented.
- Preserves ADR-0072 per-stream isolation (state lives in the manager, keyed by session).
- Intervention path (evidence gate ADR-0082, maxNudges=2 ADR-0084) unchanged.
- The incident shape now triggers intervention within 3 passes: byte-identical
  `getPersonaEntryNode` input → stable fnv1a fingerprint → per-key count hits
  threshold 3; varying-input `recallMemory` calls are ignored by exact-input
  semantics — one stable call in the cycle is enough.

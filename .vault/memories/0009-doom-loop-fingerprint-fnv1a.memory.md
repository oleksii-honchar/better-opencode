---
type: memory
title: "Doom Loop Input Fingerprint Uses fnv1a, Not sha256"
createdAt: "2026-08-01T13:22:43Z"
updatedAt: "2026-08-01T13:22:43Z"
tags: [unstuck, doom-loop, fingerprint, gotcha]
see_also:
  - "adrs/0061-dedicated-doom-loop-detection.adr.md"
  - "specifications/0012-doom-loop-nudge.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: Doom Loop Input Fingerprint Uses fnv1a, Not sha256

## Fact

The unstuck `doom_loop` detector fingerprints tool inputs with `fnv1a(JSON.stringify(input))` (8 hex chars), not the spec's proposed `sha256(...).slice(0,16)`.

## Context

Documented during the 2026-08-01 doom_loop → unstuck nudge implementation. The async sha256 approach was impractical in the synchronous `tool-input-end` consume path. Accepted deviation: sync/deterministic; equality semantics preserved.

## Impact

32-bit hash has marginally higher collision risk than 16-char sha256 truncation, negligible for input-equality checks. Do not "fix" to sha256 without a sync-hash mechanism.

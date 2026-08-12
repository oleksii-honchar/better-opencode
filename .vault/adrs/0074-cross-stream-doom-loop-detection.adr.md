---
type: adr
id: ADR-0074
title: "Cross-Stream Doom-Loop Detection via Per-Session Rolling Record"
status: accepted
createdAt: "2026-08-12T17:20:00Z"
updatedAt: "2026-08-12T17:20:00Z"
tags: [unstuck, doom-loop, cross-stream, per-session, loop-detection]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0060-allow-then-catch-doom-loop.adr.md"
  - "adrs/0061-dedicated-doom-loop-detection.adr.md"
  - "adrs/0062-doom-loop-permission-allow-default.adr.md"
  - "adrs/0072-per-stream-loop-detector.adr.md"
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "specifications/0012-doom-loop-nudge.spec.md"
---

# ADR-0074: Cross-Stream Doom-Loop Detection via Per-Session Rolling Record

## Context

The Unstuck plugin's `doom_loop` detection is scoped to a single `doStream` call (per ADR-0072). When an agent repeatedly calls the same tool with identical input across multiple separate streams (one call per stream), the detector never sees more than one call, so the threshold (default 3) is never reached.

**Real-world example:** In session `ses_009302293ffe3KacIsKYNnejAD`, the architect called `sed -i "s/17 files/14 files/g" <path>"` 30 times, each in a separate stream. Every call failed with the same error. The plugin never intervened. The model self-escaped after ~147 seconds.

The processor-level `doom_loop` gate (processor.ts:424-448) is also per-message, checking only the last 3 parts of the current assistant message. It cannot detect cross-message loops.

## Decision

Add cross-stream doom-loop detection via a per-session rolling record maintained in the `ProviderWrapper` class.

**Key design choices:**

1. **Scope:** Per-session (keyed by session ID from the prompt's `<env>` block)
2. **Location:** `ProviderWrapper` class in `provider.ts` (where `wrapWithLoopDetection` is called)
3. **Detection logic:** After per-step doom-loop detection in `streamWithDetection`, check against the session's rolling record. If (tool name + input fingerprint) matches the current run, increment count. If count >= threshold, trigger intervention.
4. **Reset:** On nudge intervention, clear the session's rolling record. On session end, clear all records for that session.
5. **Configuration:** New config fields `enableCrossStreamDoomLoopDetection` (default true) and `crossStreamDoomLoopThreshold` (default 3).

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Revert to global singleton detector (pre-ADR-0072) | Simple; cross-stream detection works automatically | Cross-session state leakage; false positives; fragile reset logic | Rejected — ADR-0072's rationale still valid |
| Per-session detector map (session ID → LoopDetectorImpl) | Reuses existing detector logic | Overkill; detector is designed for per-stream use; state management complex | Rejected — simpler to add dedicated state |
| Processor-level cross-message detection | Processor has access to all messages | Processor-level gate is per-message; would require significant changes | Rejected — provider-level is cleaner |
| Extend `tool_loop` detection to cross-stream | Reuses existing detection type | `tool_loop` is designed for cross-step detection within a stream; threshold and semantics differ | Rejected — `doom_loop` is the correct type |

## Consequences

- **Positive:** Detects cross-stream doom loops (the primary gap); preserves per-stream isolation (ADR-0072); no changes to existing detection logic; configurable.
- **Negative:** New state management in `ProviderWrapper`; session lifecycle hooks required; potential for cross-session leakage if session ID extraction fails.
- **Neutral:** Signature change in `wrapWithLoopDetection` (3 → 4 params); new config fields; new unit and integration tests required.

## Verification

✅ Verified in code: `CrossStreamDoomLoopManager` in `cross-stream-doom-loop.ts`; wired into `ProviderWrapper` (provider.ts); `wrapWithLoopDetection` accepts optional manager; session ID extracted via regex from `<env>` block in `streamWithDetection`; `recordCall` invoked after per-step doom-loop detection; nudge-and-prune path reused for cross-stream hits; `resetSession` called on nudge; config fields `enableCrossStreamDoomLoopDetection` and `crossStreamDoomLoopThreshold` added to `UnstuckConfig`; integration tests pass (cross-stream detection, cross-session isolation, per-stream preservation).

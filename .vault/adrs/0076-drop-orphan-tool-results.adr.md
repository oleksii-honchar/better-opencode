---
type: adr
id: ADR-0076
title: "Drop Orphan Tool-Results (Do Not Re-Attach Synthetic Tool-Call Parts)"
status: accepted
createdAt: "2026-08-13T10:35:00Z"
updatedAt: "2026-08-13T10:35:00Z"
tags: [tool-calls, repair, message-assembly]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0075-fix-at-assembly-layer.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0076: Drop Orphan Tool-Results (Do Not Re-Attach Synthetic Tool-Call Parts)

## Context

When the assembly detects an orphan tool-result (a `tool` message with `tool-result` part whose `toolCallId` has no matching `tool-call` part in any assistant message), two repair strategies are possible:

1. **Drop the orphan** — remove the tool-result message; the LLM never sees a tool call without a call.
2. **Re-attach** — reconstruct a minimal tool-call part (e.g., `{type:"tool-call", toolCallId, toolName:"unknown", input:{}}`) and insert it before the tool-result.

## Decision

Drop the orphan.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Drop the orphan | Matches existing `repairOrphanedInputItems` pattern; order-preserving; pure | Some context silently lost | — |
| Re-attach synthetic tool-call part | Preserves message count | Reconstructs lossy state; `toolName:"unknown"` confuses LLM; no precedent | Risk of misleading the LLM |
| Fail the request with clear error | User is informed | Disruptive — hard session failure | Worse for the user |
| Drop AND emit system message | User informed; context preserved | Not in scope; adds complexity | Deferred |

## Consequences

- **Positive:** Sessions continue functioning even when history corruption has dropped tool-call parts.
- **Positive:** Drop is order-preserving and pure; matches the existing pattern in `repairOrphanedInputItems`.
- **Negative:** Some context is silently lost (the orphaned tool result and any reasoning attached to it). Acceptable: the alternative is a hard session failure.
- **Neutral:** A `Effect.logWarning` records each drop with the `toolCallId`, enabling forensic analysis.

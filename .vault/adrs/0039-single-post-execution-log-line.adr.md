---
type: adr
id: ADR-0039
title: "Single Post-Execution Log Line per Tool Call"
status: accepted
createdAt: "2026-07-12T19:47:00Z"
updatedAt: "2026-07-12T19:47:00Z"
tags: [logging, architecture]
supersedes: []
superseded_by: []
see_also: ["adrs/0035-json-lines-format-for-tools-log.adr.md", "adrs/0041-error-logging-in-same-file.adr.md"]
---

# ADR-0039: Single Post-Execution Log Line per Tool Call

## Context

Should we log a "start" event when the tool begins and an "end" event when it finishes?

## Decision

Log a single line after execution completes (success or error). The line includes `durationMs`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Separate start + end lines | Catches hangs (start without end) | Doubles file size; start line provides no unique data beyond timestamp | Rejected — `Effect.withSpan` already provides start events for OTel collectors |

## Consequences

- **Positive:** Simpler file — one line per tool call.
- **Positive:** Start timestamp is implicit: `timestamp - durationMs`.
- **Positive:** `Effect.withSpan` already provides start events for OTel collectors; `tools.log` is for post-hoc debugging.
- **Positive:** For hangs, the absence of a line indicates an incomplete call.
- **Neutral:** A tool call that hangs forever will never produce a `tools.log` line — acceptable because the primary debugging use case is inspecting completed calls.

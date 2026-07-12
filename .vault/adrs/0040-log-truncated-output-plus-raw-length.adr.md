---
type: adr
id: ADR-0040
title: "Log Truncated Output + Raw Length"
status: accepted
createdAt: "2026-07-12T19:47:00Z"
updatedAt: "2026-07-12T19:47:00Z"
tags: [logging, data]
supersedes: []
superseded_by: []
see_also: ["adrs/0035-json-lines-format-for-tools-log.adr.md", "adrs/0039-single-post-execution-log-line.adr.md"]
---

# ADR-0040: Log Truncated Output + Raw Length

## Context

Raw tool output can be very large (e.g., `read` on a big file). The codebase already truncates output via `Truncate.output()`.

## Decision

- Log the **truncated** output string (already bounded).
- Include `rawOutputLength: number` when truncation occurred.
- Include `truncated: boolean`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Log raw output | Full data available | Can easily produce multi-megabyte lines | Rejected — unbounded log lines |
| Do not log output at all | Zero risk of large lines | Output is often the most important debugging signal | Rejected — loses critical debugging data |

## Consequences

- **Positive:** Avoids unbounded log lines while preserving enough output for debugging.
- **Positive:** `rawOutputLength` tells the user how much data was elided.
- **Negative:** Full output is not recoverable from `tools.log`; user must inspect chat history or re-run the tool.

---
type: adr
id: ADR-0035
title: "JSON Lines Format for tools.log"
status: accepted
createdAt: "2026-07-12T19:47:00Z"
updatedAt: "2026-07-12T19:47:00Z"
tags: [logging, data-format]
supersedes: []
superseded_by: []
see_also: ["adrs/0038-env-var-gating-opencode-log-tools.adr.md"]
---

# ADR-0035: JSON Lines Format for tools.log

## Context

Tool args and outputs are nested objects and can be large strings. The existing general log uses a custom plain-text format (`LEVEL ISO_TIMESTAMP +DIFFms key=value ...`).

## Decision

Use JSON Lines (one JSON object per line) for `tools.log`. Keep the existing plain-text format for the general log.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Extend existing plain-text format | Consistent with general log | Quoting large nested objects is unwieldy and fragile | Rejected — not machine-parseable, manual quoting is fragile |

## Consequences

- **Positive:** JSON is machine-parseable with `jq`, log aggregators, etc.
- **Positive:** Large nested args do not require manual quoting/escaping.
- **Positive:** One line per entry prevents multi-line wrapping issues.
- **Negative:** Users need `jq` or similar to inspect comfortably.
- **Negative:** Slightly larger file size due to JSON overhead (acceptable for debugging use case).

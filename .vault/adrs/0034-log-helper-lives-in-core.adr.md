---
type: adr
id: ADR-0034
title: "Log Helper Lives in core"
status: accepted
createdAt: "2026-07-12T19:47:00Z"
updatedAt: "2026-07-12T19:47:00Z"
tags: [logging, infrastructure]
supersedes: []
superseded_by: []
see_also: ["concepts/0006-opencode-observability.concept.md"]
---

# ADR-0034: Log Helper Lives in core

## Context

The tool execution logger needs a file stream, a path, and rotation logic. `core` already owns `Global.Path.log`, `Log.create`, and `Log.init`. `opencode` is the primary consumer of tool execution, but the logging infrastructure is generic.

## Decision

Extend `packages/core/src/util/log.ts` with `toolsLog(entry)` and internal stream management, gated by `OPENCODE_LOG_TOOLS`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Put helper in `opencode/src/tool/log.ts` | Keeps opencode focused on tools | Duplicates stream/rotation logic already in core | Rejected — core owns file-logging infrastructure |

## Consequences

- **Positive:** `core` gains a small, reusable API (`Log.toolsLog`); console/desktop packages can reuse later.
- **Positive:** `opencode` call sites import `* as Log from "@opencode-ai/core/util/log"` and call `Log.toolsLog(...)`.
- **Neutral:** Core API surface grows slightly.

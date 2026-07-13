---
type: adr
id: ADR-0049
title: "Line Count Log Rotation for tools.log"
status: accepted
createdAt: "2026-07-13T12:30:00Z"
updatedAt: "2026-07-13T12:30:00Z"
tags: [logging, infrastructure]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0037-numeric-rotation-keep-5-backups.adr.md"
  - "adrs/0038-env-var-gating-opencode-log-tools.adr.md"
---

# ADR-0049: Line Count Log Rotation for tools.log

## Context

The `TOOL_LOG_FILE_MAX_LINES` env var was requested to prevent `tools.log` from growing unbounded. The existing rotation (ADR-0037) only triggers on process start — a long-running process with heavy tool usage could produce massive log files.

## Decision

Track line count with an in-memory counter (`toolsLineCount`), incrementing on each `toolsLog()` call. When the count exceeds the configured limit (default: 1000), trigger the existing `rotateToolsLog()` via a 100ms debounced `scheduleToolsRotation()`. Register process exit handlers (`exit`, `SIGTERM`, `SIGINT`) to perform a final rotation if the threshold was exceeded at exit time. After rotation, reopen the write stream to avoid stale file descriptors.

### Key Implementation Details

- **In-memory counter** — `toolsLineCount` incremented per `toolsLog()` call (nanosecond overhead)
- **100ms debounce** — `scheduleToolsRotation()` uses `setTimeout` to coalesce burst rotation requests
- **Burst write handling** — `toolsRotating` guard prevents concurrent rotations; `toolsRotationPending` tracks deferred rotations
- **Stream reopen** — `reopenToolsWriteStream()` after rotation to avoid stale FD
- **Exit handlers** — final rotation on `exit`/`SIGTERM`/`SIGINT` if threshold exceeded

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Truncate (drop oldest N lines) | Keeps single file | O(n) read/write per truncation; blocks concurrent writes | Rejected — expensive and unsafe |
| Periodic file scan for line count | Accurate without counter | File I/O on every check; less efficient than in-memory | Rejected — unnecessary overhead |
| Size-based rotation | Standard approach | Line count is the requested metric; size is unreliable across platforms | Rejected — doesn't match requirement |
| No rotation until restart | Simplest | Defeats the purpose of the feature | Rejected — unbounded growth |

## Consequences

- **Positive:** File stays bounded; counter overhead is negligible (nanoseconds per write).
- **Positive:** Reuses existing `rotateToolsLog()` — no new rotation logic needed.
- **Positive:** Burst writes are debounced; no concurrent rotation risk.
- **Negative:** `TOOL_LOG_FILE_MAX_LINES` is cached at module load; changing it requires a process restart.
- **Negative:** File can temporarily exceed limit by 1 line (the line that triggers rotation).
- **Neutral:** Old data moves to backup files rather than being discarded (consistent with ADR-0037).
- **Neutral:** 100ms debounce means rotation may be delayed up to 100ms after threshold.

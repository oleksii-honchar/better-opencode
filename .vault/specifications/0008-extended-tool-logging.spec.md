---
type: specification
id: SPEC-0008
title: "Extended Tool Logging"
createdAt: "2026-07-11T17:55:00Z"
updatedAt: "2026-07-12T18:45:00Z"
kind: feature
status: completed
tags: [tool-logging, jsonl, debug, start-dev]
see_also:
  - "[[0034-log-helper-lives-in-core.adr.md]]"
  - "[[0035-json-lines-format-for-tools-log.adr.md]]"
  - "[[0036-unified-toolslog-helper.adr.md]]"
  - "[[0037-numeric-rotation-keep-5-backups.adr.md]]"
---

# Extended Tool Logging

## Goal

Provide actionable, filterable tool execution logs for debugging agent tool calls. Replace raw JSONL tail with formatted output and selective filtering via `scripts/start-dev.sh --tool-logs`.

## Capabilities

### JSONL Pretty-Printing

`./scripts/start-dev.sh --tool-logs` reads `$HOME/.local/share/opencode/log/tools.log` and formats each JSONL record with key fields:

| Field | Description |
|-------|-------------|
| `ts` | ISO timestamp |
| `source` | core or plugin |
| `tool`/`toolName`/`name` | Tool identifier |
| `sessionId`, `messageId`, `callId` | Trace identifiers |
| `duration` | Execution time |
| `args` | Input arguments |
| `output` | Tool output |
| `error` | Error (if any) |
| `truncated` | Truncation status |

Uses `jq` when available; falls back to raw JSON lines gracefully.

### Include/Exclude Filters

Two optional flags work alongside `--tool-logs`:

```bash
# Show only specific tools
./scripts/start-dev.sh --tool-logs --include-tools bash,write

# Hide noisy tools
./scripts/start-dev.sh --tool-logs --exclude-tools meta_use,meta_search

# Combined: include first, then exclude from that set
./scripts/start-dev.sh --tool-logs --include-tools bash,write,read --exclude-tools bash
```

**Filtering rules:**
- Comma-separated lists, no spaces (case-sensitive)
- Include takes priority: if both provided, include set is shown, then exclude removes from that set
- Matches against `tool`, `toolName`, or `name` field
- Works with or without `jq`

### Live Follow

Continuous follow mode — new log lines appear in real time, enabling live debugging of tool calls during an active session.

## Phases

### Phase 1: Pretty Print (Completed)

- Replace raw `tail -f` with JSONL pretty-printer using `jq`
- Graceful fallback when `jq` unavailable
- Error on missing `tools.log` file
- Shell syntax validation (`bash -n`)

### Phase 2: Include/Exclude Filters (Completed)

- Add `--include-tools` and `--exclude-tools` CLI flags
- Filter by tool field in `jq` pipeline
- Also filter in no-`jq` raw fallback mode
- Include priority over exclude

## Risks

- **Low:** Script only adds formatting layer; log content unchanged
- **Low:** `jq` dependency is optional with raw fallback

## Acceptance

- [x] Pretty-printed output for valid JSONL lines
- [x] Invalid lines printed raw without crashing
- [x] `--include-tools` filters to specified tools only
- [x] `--exclude-tools` hides specified tools
- [x] Combined include/exclude works correctly
- [x] `jq` fallback works when unavailable
- [x] Continuous follow mode functional
- [x] Error on missing log file preserved

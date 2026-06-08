---
type: component
title: "Session Storage Model"
c4_level: component
system: better-opencode
createdAt: "2026-06-08T18:45:00Z"
updatedAt: "2026-06-08T19:15:00Z"
tags: [session, storage, database]
see_also: ["concepts/0001-session-model.concept.md"]
linked_elements: []
---

# Component: Session Storage Model

## Overview

better-opencode stores session data in SQLite using three core tables: `sessions`, `messages`, and `parts`. Messages link to sessions, and parts link to messages. This three-tier structure supports structured content with mixed media, tool calls, and reasoning traces.

## Storage Location

The SQLite database file is located at `{xdgData}/opencode/opencode.db` by default, resolved via the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html) using the `xdg-basedir` npm package.

### Default paths by platform

| Platform | Default path |
|----------|-------------|
| macOS | `~/Library/Application Support/opencode/opencode.db` (XDG fallback: `~/.local/share/opencode/opencode.db`) |
| Linux | `~/.local/share/opencode/opencode.db` |

### Observed filesystem layout (example)

```
~/.local/share/opencode/
├── opencode.db                         81M  (default / prod channel)
├── opencode-local.db                  785M  (local channel — active)
├── opencode-patched-dev.db             15M  (patched-dev channel)
└── opencode-260430-initial-build.db    4.4M  (custom channel)
```

The active DB is determined by the installation channel (see `getChannelPath()`). In the example above, the `local` channel DB is the largest and most recently written, indicating it is the currently active database.

### Path resolution logic

`getPath()` in `packages/opencode/src/storage/db.ts` resolves the DB path in order:

1. **`Flag.OPENCODE_DB` env var set?**
   - `:memory:` → in-memory database (no file)
   - Absolute path → used directly
   - Relative path → resolved relative to `{xdgData}/opencode/`
2. **Channel path** (`getChannelPath()`)
   - If channel is `latest` / `beta` / `prod` OR `disableChannelDb` flag is set → `{xdgData}/opencode/opencode.db`
   - Otherwise → `{xdgData}/opencode/opencode-{channel}.db` (channel name sanitized)

The `xdgData` directory is defined in `packages/core/src/global.ts` as `path.join(xdgData!, "opencode")`.

## Storage Schema

```text
sessions
├── id (text, PK)           — SessionID
├── parent_id (text, FK)   — nullable SessionID, links to parent session
├── title (text)
├── agent (text)            — agent name (e.g. "default", "compaction")
├── model (json)            — { providerID, modelID, variant }
├── metadata (json)
└── time (json)             — { created, updated }

messages
├── id (text, PK)           — MessageID
├── session_id (text, FK)   — SessionID
├── data (json)             — MessageV2.Info (role, parentID, agent, model, etc.)
└── time (json)             — { created }

parts
├── id (text, PK)           — PartID
├── message_id (text, FK)   — MessageID
├── session_id (text, FK)   — SessionID (denormalized for querying)
├── data (json)             — PartInfo (type, content, state, annotations)
└── time (json)             — { start, end }
```

## Message Types

Messages are either **user** or **assistant** role. Each message contains one or more **parts**:

| Part Type | Description | Key Fields |
|-----------|-------------|------------|
| `text` | Plain text content | `text`, `agent` (who produced it) |
| `tool` | Tool call/result pair | `tool`, `tool_arguments`, `tool_result`, `tool_result_status` |
| `reasoning` | LLM chain-of-thought | `text` |
| `file` | Attached file reference | `filename`, `mime`, `path`, `size` |
| `compaction` | Context compaction marker | `auto`, `overflow`, `tail_start_id` |
| `subtask` | Sub-agent result reference | `status`, `sessionID` (child session) |

## Message Flow

```
User types message → User Message (role=user) created
                     → Assistant Message (role=assistant) created
                       → Parts streamed: text, tool-calls, reasoning
                         → Tool calls execute → tool-result parts appended
```

## Subtask Flow

```
Assistant calls task tool → ToolPart created in parent message
                           → TaskTool creates child Session with parentID
                             → Child session processes independently
                               → Result Part (subtask type) appended to parent's tool
```

## Context Compaction

When a session exceeds context limits, a **compaction** is triggered:

1. A `compaction` part is appended to the latest user message (marker with `auto`/`overflow` flags)
2. Historical parts are pruned (tool output truncated, marked with `time.compacted`)
3. A new assistant message is created with `summary: true` and `mode: "compaction"`
4. A summary is generated using the `SUMMARY_TEMPLATE` (Goal, Constraints, Progress, Decisions, Next Steps, Session State, Critical Context, Relevant Files)
5. The compaction preserves the "tail" — the most recent N turns (configurable via `tail_turns`)

### Compaction Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `PRUNE_MINIMUM` | 20,000 | Minimum tokens pruned to justify a compaction |
| `PRUNE_PROTECT` | 40,000 | Token budget protected before pruning older tool calls |
| `TOOL_OUTPUT_MAX_CHARS` | 2,000 | Max chars per tool output in compaction prompt |
| `DEFAULT_TAIL_TURNS` | 2 | Default number of recent turns to preserve |
| `MIN_PRESERVE_RECENT_TOKENS` | 2,000 | Minimum recent tokens to keep |
| `MAX_PRESERVE_RECENT_TOKENS` | 8,000 | Maximum recent tokens to keep |
| `PRUNE_PROTECTED_TOOLS` | `["skill"]` | Tools whose output is never pruned |

### Compaction Trigger Conditions

- **Auto-compaction**: When `usable(tokens) - 1.5 * output_token_budget < 0` (not enough tokens remaining for a reasonable response)
- **Overflow**: When the provider rejects the request due to context length
- **Manual**: User explicitly requests compaction

## Relevant Code

- `packages/core/src/global.ts` — `Global.Path.data` definition
- `packages/opencode/src/storage/db.ts` — `getPath()` and `getChannelPath()` resolution
- `packages/opencode/src/storage/db.bun.ts` / `db.node.ts` — Platform-specific SQLite client initialization
- `packages/opencode/src/session/session.sql.ts` — Database schema
- `packages/opencode/src/session/session.ts` — Session service (CRUD, parent-child operations)
- `packages/opencode/src/session/message-v2.ts` — Message/part schema and CRUD
- `packages/opencode/src/session/compaction.ts` — Context compaction logic
- `packages/opencode/src/session/overflow.ts` — Overflow detection
- `packages/opencode/src/tool/task.ts` — Subtask spawning via TaskTool

---
type: component
title: "Session Storage Model"
c4_level: component
system: better-opencode
createdAt: "2026-06-08T18:45:00Z"
updatedAt: "2026-06-08T19:30:00Z"
tags: [session, storage, database]
see_also: ["concepts/0001-session-model.concept.md", "adrs/0001-system-prompt-persistence.adr.md"]
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

## System Prompt

The system prompt is **not persisted** in the database. It is composed at runtime and injected as part of the LLM API request.

### Composition (runtime)

In `llm/request.ts` — `prepare()`, the system prompt is assembled from:

1. **Agent-specific prompt** (if the agent has a `prompt` field) OR **provider-specific prompt** (model-specific prompt from `session/prompt/`)
2. **System instructions** from `input.system`
3. **User system message** from `input.user.system`

```typescript
const system = [
  ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
  ...input.system,
  ...(input.user.system ? [input.user.system] : []),
].filter((x) => x).join("\n")
```

### Injection into LLM request

- **Standard API** (`llm/request.ts`): Prepended as `role: "system"` messages before `input.messages`
- **Native adapters** (`llm/native-request.ts`): Extracted and sent as a separate `system` field (not in the messages array), using `SystemPart.make()`
- **OpenAI OAuth**: Sent as `options.instructions` instead of a system message

### What IS persisted

| Content | Persisted? | How |
|---------|-----------|-----|
| System prompt | **No** | Runtime-only, injected at LLM request time |
| User messages | Yes | `messages` table, role=user |
| Assistant messages | Yes | `messages` table, role=assistant |
| Injected system messages (tool hooks) | Yes | As **user** messages wrapped in `<system-reminder>` tags |

### Injected system messages

Tool hooks (`tool.execute.after`, `session.stopping`) can inject system-role messages via the `inject` field. These ARE persisted, but as **user messages** with the text wrapped in `<system-reminder>` tags:

```typescript
const isSystem = injection.role === "system"
const wrapped = isSystem
  ? `<system-reminder>${injection.text}</system-reminder>`
  : injection.text
```

This ensures they survive compaction and are visible in the session history.

### Why you don't see it in the UI

The UI shows persisted messages from the database. The system prompt is invisible because it's never stored — it's only injected at request time when the LLM is called.

### Relevant Code

- `packages/opencode/src/session/llm/request.ts` — `prepare()` system prompt composition
- `packages/opencode/src/session/llm/native-request.ts` — Native adapter system field extraction
- `packages/opencode/src/session/system.ts` — Provider-specific prompt selector
- `packages/opencode/src/session/prompt.ts` — `flushInjectedMessages` for injected system messages

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
- `packages/opencode/src/session/llm/request.ts` — `prepare()` system prompt composition
- `packages/opencode/src/session/llm/native-request.ts` — Native adapter system field extraction
- `packages/opencode/src/session/system.ts` — Provider-specific prompt selector
- `packages/opencode/src/session/prompt.ts` — `flushInjectedMessages` for injected system messages
- `packages/opencode/src/tool/task.ts` — Subtask spawning via TaskTool

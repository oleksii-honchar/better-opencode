---
feature: store-workspace-paths
version: 1.2.0
status: implemented
source: session/260522-1601-store-workspace-paths/spec.md
pr: TBD
implementation: complete
client-side: better-openchamber/docs/spec/02-workspace-folders-multi-root.md
---

# Spec: Store VS Code Workspace Paths in Session and `<env>`

## Problem Statement

The opencode agent has no awareness of the VS Code workspace folders opened in the editor. When working across multiple projects (e.g., `better-openchamber` + `better-opencode`), the agent only sees the single working directory in the `<env>` block — it cannot see the full set of workspace folders.

This is problematic for:
- File search context — the agent searches within the working directory only, missing files in sibling workspace folders
- Code references — the agent assumes all relevant code lives in the working directory
- Session compaction — when history is summarized, the agent loses workspace context entirely

## Design Decision

**Store VS Code workspace folder paths (`vscode.workspace.workspaceFolders[].uri.fsPath`) in the Session table and inject them into the `<env>` block so they survive compaction and are available on every LLM call.**

**Approach:** Extend the existing session infrastructure — the workspace folders are passed from the Openchamber extension during session creation, stored in the Session table, and read by SystemPrompt to inject into `<env>`.

**Rationale:**
- The `<env>` block is regenerated every loop iteration — it survives compaction naturally
- Storing in the Session table provides persistence across sessions
- The Openchamber extension already has access to `vscode.workspace.workspaceFolders`

## Architecture

```
┌──────────────────────────┐
│  VS Code (Openchamber)   │
│                          │
│ vscode.workspace.        │
│   workspaceFolders[]     │
│   → [path1, path2, …]    │
└──────────┬───────────────┘
            │ Session Create API
            │ (new payload field: workspaceFolders)
            ▼
┌──────────────────────────┐
│  Opencode Server          │
│                          │
│  Session Create Handler   │
│    → stores              │
│    workspaceFolders      │
│    in Session table       │
├──────────────────────────┤
│  Session table (SQLite)   │
│    + workspace_folders   │  ← NEW COLUMN
│    - TEXT JSON array      │
├──────────────────────────┤
│  InstanceContext          │
│    + workspaceFolders    │  ← NEW FIELD
│    - string[]             │
├──────────────────────────┤
│  SystemPrompt.env()       │
│    reads session data     │
│    → injects into        │
│    <env> block            │
└──────────┬───────────────┘
            │ LLM message
            ▼
┌──────────────────────────┐
│  <env> block (in system  │
│  prompt to LLM)           │
│                          │
│  Working directory: ...   │
│  VS Code workspace ...    │
│  (additional fields)     │
└──────────────────────────┘
```

## Data Model

### Session Table (SQLite) — New Column

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Session ID (PK) |
| `directory` | TEXT | Working directory |
| `path` | TEXT | Path within workspace |
| **`workspace_folders`** | **TEXT** | **JSON array of workspace folder paths: `["/path/to/folder1", "/path/to/folder2"]`** |
| `title` | TEXT | Session title |
| `...` | ... | Other columns |

### InstanceContext — New Field

```typescript
interface InstanceContext {
  directory: string           // Working directory
  worktree: string            // Git worktree path
  project: Project.Info       // Project metadata
  workspaceFolders?: string[] // NEW: optional multi-folder list
}
```

### `<env>` Block (System Prompt)

```html
<env>
  Working directory: /Users/oleksii.honchar/www/misc/better-opencode
  Workspace root folder: /Users/oleksii.honchar/www/misc/better-opencode
  VS Code workspace folders: /Users/oleksii.honchar/www/misc/better-openchamber, /Users/oleksii.honchar/www/misc/better-opencode
  Is directory a git repo: yes
  Platform: darwin
  Today's date: Fri May 22 2026
  Session ID: ses_xxx
  Parent Session ID: ses_yyy
</env>
```

*(Single folder shows as "VS Code workspace folder:"; multiple as "VS Code workspace folders:")*

## Implementation Details

### 1. `packages/opencode/src/session/session.sql.ts`

**Change:** Add `workspace_folders` column to the Session table.

```sql
-- Existing columns...
workspace_folders TEXT  -- JSON array of strings: ["/path/to/folder1", "/path/to/folder2"]
```

- **Type:** `TEXT` storing JSON array
- **Default:** `NULL` (existing sessions won't have this field)
- **Storage:** Minimal overhead, single column

### 2. `packages/opencode/src/session/session.ts` — Session Table Row

**Change:** Add `workspace_folders` to the session table row type and fromRow mapper.

```typescript
// SessionTable row
interface SessionTable {
  workspace_folders: string | null  // JSON serialized string[]
}

// fromRow() function
workspace_folders: row.workspace_folders ?? null,
```

**Change:** Add `workspaceFolders` to Session Info schema and fromRow deserializer.

```typescript
// Session.Info schema (new optional field)
workspaceFolders: Schema.optional(Schema.Array(Schema.String)),

// fromRow() deserialize
workspaceFolders: row.workspace_folders ? JSON.parse(row.workspace_folders) : undefined,
```

**Change:** Add `workspaceFolders` to Session create input.

```typescript
// SessionCreateInput (new optional field)
workspaceFolders?: string[]

// Session create handler
const workspaceFolders = input?.workspaceFolders
  ? JSON.stringify(input.workspaceFolders)
  : null
```

### 3. `packages/opencode/src/project/instance-context.ts`

**Change:** Add `workspaceFolders` to the InstanceContext interface.

```typescript
export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
  workspaceFolders?: string[]  // NEW: optional multi-folder list
}
```

### 4. `packages/opencode/src/project/instance-store.ts`

**Change:** Extend LoadInput and boot() to accept and propagate `workspaceFolders`.

```typescript
export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
  workspaceFolders?: string[]  // NEW: optional multi-folder list
}

// In boot(), pass workspaceFolders through:
const ctx: InstanceContext = {
  directory: input.directory,
  worktree: result.sandbox,
  project: result.project,
  workspaceFolders: input.workspaceFolders,  // NEW
}
```

### 5. `packages/opencode/src/session/system.ts`

**Change:** Add `workspaceFolders` parameter to the environment() function and inject into `<env>` block.

```typescript
// SystemPrompt environment() interface
interface Interface {
  readonly environment: (
    model: Provider.Model,
    sessionID?: string,
    parentSessionID?: string,
    workspaceFolders?: string[]  // NEW
  ) => Effect.Effect<string[]>
}

// environment() implementation - inject into env block
return [
  [ // ... other fields ...
    ...(workspaceFolders && workspaceFolders.length > 0 ? [
      `  VS Code workspace folders: ${workspaceFolders.join(", ")}`,
    ] : []),
  ].join("\n"),
]
```

### 6. `packages/opencode/src/session/prompt.ts`

**Change:** Pass `session.workspaceFolders` to the environment() call.

```typescript
// Before
sys.environment(model, sessionID, session.parentID)

// After
sys.environment(
  model,
  sessionID,
  session.parentID,
  session.workspaceFolders  // NEW: read from session data
)
```

### 7. Openchamber Extension (Client-Side)

**Implemented in:** [02-workspace-folders-multi-root.md](../../better-openchamber/docs/spec/02-workspace-folders-multi-root.md)

**Change:** Pass `workspaceFolders` in session create API calls from VS Code extension through webview to SDK.

**Data flow:**
```
vscode.workspace.workspaceFolders
  → webviewHtml.ts (compute array, normalize paths, inject into __VSCODE_CONFIG__)
    → webview (read from __VSCODE_CONFIG__)
      → session-actions.ts (SDK call with $body_ prefix)
        → server (CreateInput.body.workspaceFolders)
```

**SDK limitation:** The SDK v2's `Session2.create` uses `buildClientParams` with a field definition that does not include `workspaceFolders`. Unknown keys are silently dropped. The `$body_` prefix workaround forces the key into the request body:

```typescript
// session-actions.ts
const result = await sdk().session.create({
  directory: directoryOverride ?? dir(),
  title,
  parentID: parentID ?? undefined,
  ...(workspaceFolders ? { $body_workspaceFolders: workspaceFolders } : {}),
} as Record<string, unknown>)
```

The `$body_` prefix is recognized by `buildClientParams` (`$body_: "body"` in `params.gen.js`), which strips the prefix and places the value in `params.body`.

**Extension implementation:**
- `ChatViewProvider.ts`, `AgentManagerPanelProvider.ts`, `SessionEditorPanelProvider.ts` — compute `workspaceFolders` array with `normalizeWindowsDriveLetter`, pass to `getWebviewHtml()`
- `webviewHtml.ts` — `workspaceFolders` in `WebviewHtmlOptions`, injected into `__VSCODE_CONFIG__` as `JSON.stringify(workspaceFolders || [])`
- `session-ui-store.ts` — reads `workspaceFolders` from `__VSCODE_CONFIG__` in `sendMessage` and `createSessionFromAssistantMessage` handlers
- `desktop.d.ts` — `__VSCODE_CONFIG__` type declaration with `workspaceFolders?: string[]`

**Backward compatibility:** `workspaceFolder` (singular) preserved alongside `workspaceFolders` (plural). Empty array produces no body field.

### 8. Auto-Allow Workspace Folders in `external_directory` Permissions

**What:** Any path inside a VS Code workspace folder is auto-allowed for `external_directory` permission — no agent-level `external_directory` rules needed.

**How:** In `packages/opencode/src/agent/agent.ts`, the `whitelistedDirs` array is extended with workspace folder paths:

```typescript
const whitelistedDirs = [
  Truncate.GLOB,
  path.join(Global.Path.tmp, "*"),
  ...skillDirs.map((dir) => path.join(dir, "*")),
  ...(ctx.workspaceFolders ?? []).map((dir) => path.join(dir, "*")),
]
```

**Result:** If `~/.agents/skills` is in the workspace folders, the agent never asks permission for files inside it — no `external_directory` rule needed in agent config.

**Risk:** None — the existing `external_directory` deny rules still take precedence. This only adds auto-allow rules.

## Success Criteria

- [x] VS Code workspace folder paths are stored in session data and survive session compaction
- [x] `<env>` block in system prompt includes workspace folder paths
- [x] Solution works with multi-folder workspaces (e.g., openchamber + opencode)
- [x] Backwards compatible with existing sessions (NULL column)
- [x] OpenChamber type-check passes
- [x] OpenChamber build succeeds

## Open Decisions

| Decision | Value | Rationale |
|----------|-------|-----------|
| JSON vs CSV for storage | JSON in TEXT | Easier to parse, more flexible. Standard SQLite pattern for array data. |
| Session-only vs InstanceContext | Both | Session table for persistence, InstanceContext for runtime availability |
| Extension: all folders or selective | All folders | Captures full workspace context without requiring user config. Simplest default. |

## Files Modified

### Server-side (better-opencode)

| File | Change |
|------|--------|
| `packages/opencode/src/session/session.sql.ts` | Add `workspace_folders` column |
| `packages/opencode/src/session/session.ts` | Add field to Session table row, fromRow(), toRow(), CreateInput schema |
| `packages/opencode/src/project/instance-context.ts` | Add `workspaceFolders` to InstanceContext |
| `packages/opencode/src/project/instance-store.ts` | Add `workspaceFolders` to LoadInput, pass through boot() |
| `packages/opencode/src/session/system.ts` | Add param, inject into env block |
| `packages/opencode/src/session/prompt.ts` | Pass session.workspaceFolders to environment() |

### Client-side (better-openchamber)

| File | Change |
|------|--------|
| `packages/vscode/src/webviewHtml.ts` | `workspaceFolders` in options, injected into `__VSCODE_CONFIG__` |
| `packages/vscode/src/ChatViewProvider.ts` | Compute and pass `workspaceFolders` |
| `packages/vscode/src/AgentManagerPanelProvider.ts` | Compute and pass `workspaceFolders` |
| `packages/vscode/src/SessionEditorPanelProvider.ts` | Compute and pass `workspaceFolders` |
| `packages/ui/src/sync/session-actions.ts` | `createSession` accepts `workspaceFolders`, `$body_` prefix for SDK body |
| `packages/ui/src/sync/session-ui-store.ts` | Read from `__VSCODE_CONFIG__`, pass to `createSession` |
| `packages/ui/src/types/desktop.d.ts` | `__VSCODE_CONFIG__` type with `workspaceFolders` |

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Backward compatibility | Low | Column is nullable; existing sessions have NULL |
| JSON serialization errors | Low | Store as TEXT; handle parse errors gracefully |
| Session table migration | Low | Drizzle migration adds column (ALTER TABLE) |
| Extension compatibility | Medium | Extension change is isolated; only affects sessions it creates |
| InstanceContext field unused | Low | Optional field; existing code path works without it |

## Session

- **Server-side session:** 260522-1601-store-workspace-paths (May 22, 2026)
- **Client-side session:** ses_1a67a3079ffeslu3O06tl8RZM4 (May 24, 2026)

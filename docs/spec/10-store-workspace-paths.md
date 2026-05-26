---
feature: store-workspace-paths
version: 1.3.0
status: fully-implemented
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

// In boot(), pass workspaceFolders through both branches:
const ctx: InstanceContext =
  input.project !== undefined && input.worktree !== undefined
    ? {
        directory: input.directory,
        worktree: input.worktree,
        project: input.project,
        workspaceFolders: input.workspaceFolders,  // NEW
      }
    : yield* project.fromDirectory(input.directory).pipe(
        Effect.map((result) => ({
          directory: input.directory,
          worktree: result.sandbox,
          project: result.project,
          workspaceFolders: input.workspaceFolders,  // NEW
        })),
      )
```

**Note — Regression fix (session 260526-1718-opencode-extdir-perm):** The original implementation of `boot()` had two bugs:
1. The `project.fromDirectory()` branch (the common code path) omitted `workspaceFolders` from the returned object, breaking the `external_directory` auto-allow for workspace folder paths. This was fixed by adding `workspaceFolders: input.workspaceFolders` to the `Effect.map()` return.
2. The condition `input.project && input.worktree` used JavaScript truthiness, which would incorrectly reject falsy-but-defined values (e.g., an empty-string `worktree`). Changed to `input.project !== undefined && input.worktree !== undefined` for explicit undefined checks.

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
      → session-actions.ts (SDK call with $body_ prefix workaround)
        → SDK buildClientParams strips "$body_" → body.workspaceFolders
          → server (CreateInput.body.workspaceFolders)
```

**SDK limitation (npm SDK only):** The npm-published SDK v1.14.19's `Session2.create` uses `buildClientParams` with a field definition that does not include `workspaceFolders`. Unknown keys are silently dropped. The `$body_` prefix workaround forces the key into the request body:

```typescript
// session-actions.ts (OpenChamber extension — npm SDK v1.14.19)
const result = await sdk().session.create({
  directory: directoryOverride ?? dir(),
  title,
  parentID: parentID ?? undefined,
  ...(workspaceFolders ? { $body_workspaceFolders: workspaceFolders } : {}),
} as Record<string, unknown>)
```

The `$body_` prefix is recognized by `buildClientParams` (`$body_: "body"` in `params.gen.js`), which strips the prefix and places the value in `params.body`.

**Note:** The local SDK at `better-opencode/packages/sdk` (sdk.gen.ts:3101) has `workspaceFolders` as a native field. The standalone app (`better-opencode/packages/app`) uses the native field directly. Only the OpenChamber extension's npm SDK dependency requires the workaround.

**Extension implementation:**
- `ChatViewProvider.ts`, `AgentManagerPanelProvider.ts`, `SessionEditorPanelProvider.ts` — compute `workspaceFolders` array with `normalizeWindowsDriveLetter`, pass to `getWebviewHtml()`
- `webviewHtml.ts` — `workspaceFolders` in `WebviewHtmlOptions`, injected into `__VSCODE_CONFIG__` as `JSON.stringify(workspaceFolders || [])`
- `session-ui-store.ts` — reads `workspaceFolders` from `__VSCODE_CONFIG__` in `sendMessage` and `createSessionFromAssistantMessage` handlers
- `desktop.d.ts` — `__VSCODE_CONFIG__` type declaration with `workspaceFolders?: string[]`

**Backward compatibility:** `workspaceFolder` (singular) preserved alongside `workspaceFolders` (plural). Empty array produces no body field.

### 8. Auto-Allow Workspace Folders in `external_directory` Permissions

**What:** Any path inside a VS Code workspace folder is auto-allowed for `external_directory` permission — no agent-level `external_directory` rules needed.

**How:** `workspaceFolders` is threaded from the session through the middleware chain to `InstanceContext`, then used by `Agent.state` in the `whitelistedDirs` array.

**Data flow (after Fix 1 + Fix 2):**
```
VS Code Extension
  → webviewHtml.ts (injects workspaceFolders into __VSCODE_CONFIG__)
    → OpenChamber webview (session-ui-store.ts reads __VSCODE_CONFIG__.workspaceFolders)
      → session-actions.ts (SDK call with $body_workspaceFolders workaround)
        → SDK buildClientParams strips "$body_" → body.workspaceFolders
          → Session (workspaceFolders from DB)
            → WorkspaceRoutingMiddleware (reads session, extracts workspaceFolders)
            → WorkspaceRouteContext ({ directory, workspaceID, workspaceFolders })
              → InstanceContextMiddleware (passes to store.load)
                → InstanceStore (creates InstanceContext with workspaceFolders)
                  → Agent.state (uses ctx.workspaceFolders in whitelistedDirs)
                  → assertExternalDirectory (containsPath check on InstanceContext)
                    → FIX 2: WorkspaceFoldersRef defensive check (per-request fallback)
```

**agent.ts:** The `whitelistedDirs` array includes workspace folder paths:

```typescript
const whitelistedDirs = [
  Truncate.GLOB,
  path.join(Global.Path.tmp, "*"),
  ...skillDirs.map((dir) => path.join(dir, "*")),
  ...(ctx.workspaceFolders ?? []).map((dir) => path.join(dir, "*")),
]
```

**middleware:** `WorkspaceRouteContext` is extended with `workspaceFolders?: string[]`, populated from the session in `WorkspaceRoutingMiddleware`. `InstanceContextMiddleware` passes `route.workspaceFolders` to `store.load()`.

**Files affected:**
- `packages/opencode/src/agent/agent.ts` — add `ctx.workspaceFolders` to whitelistedDirs
- `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts` — add `workspaceFolders` to `WorkspaceRouteContext`, `RequestPlan.Local`, thread through `planRequest`
- `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts` — pass `route.workspaceFolders` to `store.load`

**Result:** If `~/.agents/skills` is in the workspace folders, the agent never asks permission for files inside it — no `external_directory` rule needed in agent config.

**Risk:** None — the existing `external_directory` deny rules still take precedence. This only adds auto-allow rules.

**Bug discovered (session 260525-1244-auto-allow-workspace-folders):** The original 1-line fix in `Agent.state` was correct but didn't work end-to-end because the VS Code extension's web app created sessions without `workspaceFolders`. The CLI already passed `workspaceFolders`, but the web app did not. Two fixes were applied:

### Fix 1 — OpenChamber Extension passes workspaceFolders at session creation (PRIMARY)

**Problem:** The OpenChamber extension's `packages/ui/src/sync/session-actions.ts` read `workspaceFolders` from `__VSCODE_CONFIG__` but used the `$body_workspaceFolders` workaround with an unsafe `as Record<string, unknown>` type cast to pass it to the SDK. The standalone app (`better-opencode/packages/app`) was also fixed to read `globalThis.__opencode_workspaceFolders` and pass it natively.

**Two codebases, two fixes:**

**A. OpenChamber extension** (`better-openchamber/packages/ui/src/sync/session-actions.ts`):
```typescript
// Uses $body_ prefix workaround because npm SDK v1.14.19 doesn't have workspaceFolders
const result = await sdk().session.create({
  directory: directoryOverride ?? dir(),
  title,
  parentID: parentID ?? undefined,
  ...(workspaceFolders ? { $body_workspaceFolders: workspaceFolders } : {}),
} as Record<string, unknown>)
```
**Note:** The local SDK at `better-opencode/packages/sdk` has `workspaceFolders` as a native field (sdk.gen.ts:3101), but the npm-published SDK v1.14.19 does not. The `$body_` prefix workaround is necessary until the npm SDK is updated. The `as Record<string, unknown>` cast bypasses TypeScript checking — this is a known limitation.

**B. Standalone app** (`better-opencode/packages/app/src/components/prompt-input/submit.ts`):
```typescript
// Uses native workspaceFolders field (local SDK has it)
const workspaceFolders = (globalThis as any).__opencode_workspaceFolders
const created = await client.session.create(workspaceFolders ? { workspaceFolders } : undefined)
```

**Why this approach:** The extension already injects the global into `__VSCODE_CONFIG__`. The local SDK already accepts `workspaceFolders` (sdk.gen.ts:3101). The server handler already reads it (session.ts:155). The DB schema already supports it (session.ts:233). Zero server changes needed.

**Files changed:**
- `better-openchamber/packages/ui/src/sync/session-actions.ts` (OpenChamber extension — `$body_` workaround)
- `better-opencode/packages/app/src/components/prompt-input/submit.ts` (standalone app — native field)

### Fix 2 — Defensive WorkspaceFoldersRef check in assertExternalDirectory

**Problem:** Even with Fix 1, there's a window where the cached `InstanceContext` may have `undefined` workspaceFolders (e.g., first boot before session exists). `WorkspaceFoldersRef` is per-request and may already have the value from the session.

**Fix:** After the existing `containsPath(ins)` check, add a check using `WorkspaceFoldersRef`:

```typescript
// After the existing containsPath check:
const workspaceFolders = yield* WorkspaceFoldersRef
if (workspaceFolders?.some((folder) => AppFileSystem.contains(folder, full))) return
```

**File changed:** `packages/opencode/src/tool/external-directory.ts`

**Why both fixes:** Fix 1 solves the root cause (workspaceFolders now reach the session). Fix 2 is the safety net for the brief window where the cached `InstanceContext` might be stale.

## Success Criteria

- [x] VS Code workspace folder paths are stored in session data and survive session compaction
- [x] `<env>` block in system prompt includes workspace folder paths
- [x] Solution works with multi-folder workspaces (e.g., openchamber + opencode)
- [x] Backwards compatible with existing sessions (NULL column)
- [x] OpenChamber type-check passes
- [x] OpenChamber build succeeds
- [x] Agent auto-allows workspace folder paths for `external_directory` permission

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
| `packages/opencode/src/project/instance-store.ts` | Add `workspaceFolders` to LoadInput, pass through boot() both branches; use `!== undefined` checks (regression fix 260526-1718) |
| `packages/opencode/src/session/system.ts` | Add param, inject into env block |
| `packages/opencode/src/session/prompt.ts` | Pass session.workspaceFolders to environment() |
| `packages/opencode/src/agent/agent.ts` | Add `ctx.workspaceFolders` to whitelistedDirs |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts` | Add `workspaceFolders` to `WorkspaceRouteContext`, `RequestPlan.Local`, thread through `planRequest` |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts` | Pass `route.workspaceFolders` to `store.load` |
| `packages/app/src/components/prompt-input/submit.ts` | Read `globalThis.__opencode_workspaceFolders` and pass to `client.session.create()` (Fix 1) |
| `packages/app/src/components/prompt-input/submit.test.ts` | Tests for workspaceFolders passing (Fix 1) |
| `packages/opencode/src/tool/external-directory.ts` | Add `WorkspaceFoldersRef` defensive check (Fix 2) |
| `packages/opencode/test/tool/external-directory.test.ts` | Tests for WorkspaceFoldersRef short-circuit (Fix 2) |

### Client-side (better-openchamber)

| File | Change |
|------|--------|
| `packages/vscode/src/webviewHtml.ts` | `workspaceFolders` in options, injected into `__VSCODE_CONFIG__` |
| `packages/vscode/src/ChatViewProvider.ts` | Compute and pass `workspaceFolders` |
| `packages/vscode/src/AgentManagerPanelProvider.ts` | Compute and pass `workspaceFolders` |
| `packages/vscode/src/SessionEditorPanelProvider.ts` | Compute and pass `workspaceFolders` |
| `packages/ui/src/sync/session-actions.ts` | `createSession` accepts `workspaceFolders`, `$body_` prefix workaround for npm SDK (native field in local SDK) |
| `packages/ui/src/sync/session-ui-store.ts` | Read from `__VSCODE_CONFIG__`, pass to `createSession` |
| `packages/ui/src/types/desktop.d.ts` | `__VSCODE_CONFIG__` type with `workspaceFolders` |

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Backward compatibility | Low | Column is nullable; existing sessions have NULL |
| JSON serialization errors | Low | Store as TEXT; handle parse errors gracefully |
| Session table migration | Low | Drizzle migration adds column (ALTER TABLE) |
| Extension compatibility | Medium | Extension change is isolated; only affects sessions it creates |
| InstanceContext field unused | Low | Optional field; used by auto-allow feature since v1.2.0 |

## Bug History

| Date | Session | Issue | Fix |
|------|---------|-------|-----|
| 2026-05-26 | 260526-1718-opencode-extdir-perm | `workspaceFolders` omitted in `InstanceStore.boot`'s `fromDirectory()` branch; `input.project && input.worktree` used truthiness instead of undefined checks | Added `workspaceFolders: input.workspaceFolders` to `Effect.map()` return; changed to `!== undefined` checks |
| 2026-05-25 | 260525-1244-auto-allow-workspace-folders | Web app created sessions without `workspaceFolders`; `assertExternalDirectory` didn't check `WorkspaceFoldersRef` | **Fix 1:** OpenChamber extension reads `__VSCODE_CONFIG__.workspaceFolders` and passes to SDK (uses `$body_` workaround for npm SDK). Standalone app reads `globalThis.__opencode_workspaceFolders` and passes to `client.session.create({ workspaceFolders })` (native field). **Fix 2:** `assertExternalDirectory` checks `WorkspaceFoldersRef` after `containsPath` as defensive fallback.

## Investigation — Fix 1 + Fix 2 Still Prompt (260526-260526)

**Problem:** After Fix 1 + Fix 2, the researcher agent **sometimes** STILL asks permission for paths inside VS Code workspace folders.

**Key findings from codebase analysis:**

### Finding 1 — `Agent.state()` is NOT cached (GOOD)

`Effect.fn("Agent.state")` is a **named Effect wrapper**, NOT a memoizer. Each call to `Agent.get(agentName)` calls `state()` which recomputes `agents` with the current `WorkspaceFoldersRef` value. This means the agent's `external_directory` allow rules are always up-to-date with the current request's `WorkspaceFoldersRef`.

**Evidence:**
- `agent.ts` line 97: `const state = Effect.fn("Agent.state")(function* () { ... yield* WorkspaceFoldersRef ... })`
- `agent.ts` line 380: `get: Effect.fn("Agent.get")(function* (agent) { const s = yield* state(); return yield* s.get(agent) })`
- Each `Agent.get` call re-evaluates `state()` → reads current `WorkspaceFoldersRef`

### Finding 2 — `assertExternalDirectory` Fix 2 is correct (GOOD)

Fix 2 reads `WorkspaceFoldersRef` (per-request) AFTER the cached `containsPath` check:
- `external-directory.ts` line 28: `containsPath(full, ins)` → cached `InstanceRef` (may have stale workspaceFolders)
- `external-directory.ts` line 33-34: `WorkspaceFoldersRef` → per-request value from middleware

If `WorkspaceFoldersRef` is set correctly by middleware, Fix 2 should catch paths that `containsPath` misses.

### Finding 3 — InstanceStore caching (CONFIRMED ISSUE)

`InstanceStore.load()` caches by directory only:
- First boot: `workspaceFolders: undefined` → cached instance has `undefined` workspaceFolders
- Subsequent requests: cached instance returned → `ctx.workspaceFolders` still `undefined`
- `containsPath(full, ins)` fails because `ins.workspaceFolders` is `undefined`

**This is why Fix 2 is needed.** However, Fix 2 only works if `WorkspaceFoldersRef` is set.

### Finding 4 — `WorkspaceFoldersRef` can be undefined (ROOT CAUSE CANDIDATE)

`WorkspaceFoldersRef` is set by `InstanceContextMiddleware` from `route.workspaceFolders`:
```typescript
// instance-context.ts line 27-38
const route = yield* WorkspaceRouteContext
const ctx = yield* store.load({ directory, workspaceFolders: route.workspaceFolders })
return yield* effect.pipe(
  Effect.provideService(WorkspaceFoldersRef, route.workspaceFolders),
)
```

`route.workspaceFolders` comes from `WorkspaceRouteContext`, which comes from `WorkspaceRoutingMiddleware.planRequest()`:
```typescript
// workspace-routing.ts line 222-229
const session = sessionID ? yield* Session.Service.use((svc) => svc.get(sessionID)) : undefined
const plan = yield* planRequest(request, session?.workspaceID, session?.workspaceFolders)
```

**If the session has no `workspaceFolders`, then `route.workspaceFolders` is undefined, then `WorkspaceFoldersRef` is undefined, and Fix 2 does nothing.**

### Finding 5 — The permission ruleset path also needs workspaceFolders

Beyond `assertExternalDirectory`, the agent's `external_directory` ruleset is used by `ctx.ask`:
```typescript
// tools.ts line 121
ruleset: Permission.merge(input.agent.permission, input.session.permission ?? [])
```

`input.agent.permission` comes from `Agent.get(agentName)`, which calls `Agent.state()`, which reads `WorkspaceFoldersRef` to build `whitelistedDirs`. If `WorkspaceFoldersRef` is undefined, the agent's ruleset lacks workspace folder allow rules, and the permission system falls through to "ask".

### Finding 6 — Session creation is the critical path

The entire chain starts at session creation:
```
App (submit.ts line 365-368)
  → reads globalThis.__opencode_workspaceFolders
  → passes to client.session.create({ workspaceFolders })
  → stored in Session table
  → read by WorkspaceRoutingMiddleware
  → provided as WorkspaceFoldersRef
  → used by assertExternalDirectory (Fix 2) AND Agent.state (ruleset)
```

**If the session was created without `workspaceFolders` (old session, or app didn't pass it), then:**
1. `WorkspaceFoldersRef` is undefined → Fix 2 fails
2. `Agent.state()` reads undefined → no workspace folder allow rules in ruleset
3. `assertExternalDirectory` falls through → permission prompt

### Remaining question: Why "sometimes"?

The issue happens **sometimes** because:
1. **Old sessions** created before Fix 1 had no `workspaceFolders` — they still prompt
2. **Race condition**: If `globalThis.__opencode_workspaceFolders` is not set at session creation time (e.g., extension didn't inject it yet), the session has no `workspaceFolders`
3. **CLI vs App**: CLI already passes `workspaceFolders` (Fix 1 was only for the web app). If the user is using the app (not CLI), Fix 1 applies. But if the app's global is not set, it fails.

### Fix 3 needed: InstanceStore must invalidate cache when workspaceFolders change

The InstanceStore cache is keyed only by directory. If a request arrives with `workspaceFolders` that differ from the cached instance's `workspaceFolders`, the cache should be invalidated so `containsPath` can use the correct value. Currently:
- `store.load({ directory, workspaceFolders: ["/path"] })` → returns cached instance with `workspaceFolders: undefined`
- Fix 2 works as fallback, but the root cause (stale cache) remains

### Open questions for architect

1. Should `InstanceStore.load()` key include `workspaceFolders`? (Would require `reload()` on change)
2. Should the `containsPath` check in `assertExternalDirectory` be replaced entirely with the `WorkspaceFoldersRef` check? (Eliminates the cache issue)
3. Should `Agent.state()` read `WorkspaceFoldersRef` with a higher priority than `InstanceRef.workspaceFolders`? (Currently does — `(yield* WorkspaceFoldersRef) ?? ctx?.workspaceFolders`)

## Session

- **Server-side session:** 260522-1601-store-workspace-paths (May 22, 2026)
- **Client-side session:** ses_1a67a3079ffeslu3O06tl8RZM4 (May 24, 2026)
- **Regression fix session:** 260526-1718-opencode-extdir-perm (May 26, 2026)
- **Auto-allow fix session:** 260525-1244-auto-allow-workspace-folders (May 25-26, 2026) — Fix 1 (app passes workspaceFolders) and Fix 2 (defensive WorkspaceFoldersRef check)

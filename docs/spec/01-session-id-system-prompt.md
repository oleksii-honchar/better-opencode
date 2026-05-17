---
feature: session-id-system-prompt
version: 1.0.0
status: spec
source: architect/spec.md (Patch 3)
pr: N/A (custom commit 50d0b4dcfd)
implementation: pending
---

# Spec: Session ID in System Prompt

## Implementation Status

| Status | Description |
|--------|-------------|
| **Status** | ⏳ **Pending** — Not yet implemented |
| **Source** | Custom commit `50d0b4dcfd` on `patched/dev` branch |
| **Next Step** | Cherry-pick or manually apply to `patched/dev` |

## Problem Statement

The opencode agent has no awareness of its own session identity. When debugging, coordinating multi-session workflows, or building plugins that need session context, the agent cannot reference its session ID. This is especially problematic after session compaction, where message history is summarized but the system prompt is rebuilt from scratch.

## Design Decision

**The session ID must appear in the system prompt `<env>` block, not in message history.**

**Rationale:**
- System prompt is rebuilt every loop iteration — it survives compaction
- Message history is summarized/compacte

## Files Modified

| File | Lines Added | Lines Removed |
|------|-------------|---------------|
| `packages/opencode/src/session/system.ts` | +4 | -2 |
| `packages/opencode/src/session/prompt.ts` | +1 | -1 |

## Implementation Details

### 1. `packages/opencode/src/session/system.ts`

**Interface change (line 36):**

```typescript
// Before
readonly environment: (model: Provider.Model) => string[]

// After
readonly environment: (model: Provider.Model, sessionID?: string, parentSessionID?: string) => string[]
```

**Implementation change (line 48):**

```typescript
// Before
environment(model) {
  return [
    [
      `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${Instance.directory}`,
      `  Workspace root folder: ${Instance.worktree}`,
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      `</env>`,
    ].join("\n"),
  ]
}

// After
environment(model, sessionID, parentSessionID) {
  return [
    [
      `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${Instance.directory}`,
      `  Workspace root folder: ${Instance.worktree}`,
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      ...(sessionID ? [`  Session ID: ${sessionID}`] : []),
      ...(parentSessionID ? [`  Parent Session ID: ${parentSessionID}`] : []),
      `</env>`,
    ].join("\n"),
  ]
}
```

### 2. `packages/opencode/src/session/prompt.ts` (line ~1444)

```typescript
// Before
Effect.sync(() => sys.environment(model)),

// After
Effect.sync(() => sys.environment(model, sessionID, session.parentID)),
```

**Note:** Variables `sessionID` and `session.parentID` are already available in scope (confirmed at lines 1455-1456).

## OpenChamber Impact Assessment

| File | Change Type | Impact |
|------|-------------|--------|
| `system.ts` | Optional parameter added | **None** — optional parameter is backward-compatible |
| `prompt.ts` | Internal call site | **None** — not exported |

**Risk Level:** Very Low

## Success Criteria

- [ ] System prompt contains `Session ID: ses_...` line on every LLM call
- [ ] System prompt contains `Parent Session ID: ses_...` line when parent exists
- [ ] Session ID survives session compaction
- [ ] OpenChamber type-check passes
- [ ] OpenChamber build succeeds

---
feature: session-id-system-prompt
version: 1.0.0
status: implemented
source: architect/spec.md (Patch 3)
pr: N/A (custom commit 50d0b4dcfd)
implementation: completed
---

# Spec: Session ID in System Prompt

## Implementation Status

| Status | Description |
|--------|-------------|
| **Status** | ✅ **Completed** — Implemented directly in `patched/dev` branch |
| **Source** | Custom commit `50d0b4dcfd` (now merged into codebase) |
| **Build** | ✅ Verified — `bun turbo typecheck` passes, `bun run --cwd packages/opencode build` succeeds |

## Problem Statement

The opencode agent has no awareness of its own session identity. When debugging, coordinating multi-session workflows, or building plugins that need session context, the agent cannot reference its session ID. This is especially problematic after session compaction, where message history is summarized but the system prompt is rebuilt from scratch.

## Design Decision

**The session ID must appear in the system prompt `<env>` block, not in message history.**

**Rationale:**
- System prompt is rebuilt every loop iteration — it survives compaction
- Message history is summarized/compacte

## Files Modified

| File | Lines Added | Lines Removed |
|------|-------------|---------------|
| `packages/opencode/src/session/system.ts` | +4 | -2 |
| `packages/opencode/src/session/prompt.ts` | +1 | -1 |

## Implementation Details

### 1. `packages/opencode/src/session/system.ts`

**Interface change (line 36):**

```typescript
// Before
readonly environment: (model: Provider.Model) => string[]

// After
readonly environment: (model: Provider.Model, sessionID?: string, parentSessionID?: string) => string[]
```

**Implementation change (line 48):**

```typescript
// Before
environment(model) {
  return [
    [
      `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${Instance.directory}`,
      `  Workspace root folder: ${Instance.worktree}`,
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      `</env>`,
    ].join("\n"),
  ]
}

// After
environment(model, sessionID, parentSessionID) {
  return [
    [
      `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${Instance.directory}`,
      `  Workspace root folder: ${Instance.worktree}`,
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      ...(sessionID ? [`  Session ID: ${sessionID}`] : []),
      ...(parentSessionID ? [`  Parent Session ID: ${parentSessionID}`] : []),
      `</env>`,
    ].join("\n"),
  ]
}
```

### 2. `packages/opencode/src/session/prompt.ts` (line ~1444)

```typescript
// Before
Effect.sync(() => sys.environment(model)),

// After
Effect.sync(() => sys.environment(model, sessionID, session.parentID)),
```

**Note:** Variables `sessionID` and `session.parentID` are already available in scope (confirmed at lines 1455-1456).

## OpenChamber Impact Assessment

| File | Change Type | Impact |
|------|-------------|--------|
| `system.ts` | Optional parameter added | **None** — optional parameter is backward-compatible |
| `prompt.ts` | Internal call site | **None** — not exported |

**Risk Level:** Very Low

## Success Criteria

- [ ] System prompt contains `Session ID: ses_...` line on every LLM call
- [ ] System prompt contains `Parent Session ID: ses_...` line when parent exists
- [ ] Session ID survives session compaction
- [ ] OpenChamber type-check passes
- [ ] OpenChamber build succeeds

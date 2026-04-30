---
feature: session-stopping-hook
version: 1.0.0
status: spec
source: architect/spec.md (Patch 2, PR #16598)
pr: anomalyco/opencode#16598
implementation: pending
---

# Spec: session.stopping hook

## Implementation Status

| Status | Description |
|--------|-------------|
| **Status** | ⏳ **Pending** — Not yet implemented |
| **Source** | PR #16598 (unmerged upstream) |
| **PR Ref** | `pr-16598` (local branch) |
| **Next Step** | Cherry-pick from PR ref or manually apply |

## Problem Statement

Plugins cannot intercept the agent's idle/stop state. When the agent naturally stops (e.g., after completing a task), there is no mechanism to inject a follow-up message and keep the agent running. This prevents patterns like "You haven't updated progress.md yet — continue working."

## Design Decision

**A new `session.stopping` hook is added that runs before the agent transitions to "stopped" state.**

**Rationale:**
- Minimal change to existing session status logic
- Complements PR #19519: #19519 handles mid-session reminders; #16598 handles session-end interception
- If the hook returns `{ continue: true, message?: string }`, the agent continues instead of stopping
- If a message is provided, it is injected as a synthetic user message

## Files Modified

| File | Lines Added | Lines Removed |
|------|-------------|---------------|
| `packages/plugin/src/index.ts` | +10 | 0 |
| `packages/opencode/src/session/status.ts` | ~30 | 0 |
| `packages/opencode/src/session/prompt.ts` | ~20 | 0 |

## Implementation Details

### 1. `packages/plugin/src/index.ts` — Add session.stopping hook definition

**Location:** After existing hooks (~line 332)

```typescript
/**
 * Called before the agent loop exits. Set `output.stop = false` and
 * provide `output.message` to inject a user message and continue the loop.
 */
"session.stopping"?: (
  input: { sessionID: string },
  output: { stop: boolean; message?: string },
) => Promise<void>
```

### 2. `packages/opencode/src/session/status.ts` — Trigger hook before stopping

**Location:** In the status transition logic, before setting "stopped" state

```typescript
// Before transitioning to "stopped", check if plugin wants to continue
const stoppingResult = yield* plugin.trigger("session.stopping", { sessionID }, { stop: true })
if (stoppingResult.stop === false) {
  // Plugin wants us to continue — inject message if provided
  if (stoppingResult.message) {
    const wrappedMessage = `<system-reminder>${stoppingResult.message}</system-reminder>`
    // Inject as synthetic user message
    msgs.push({
      info: {
        role: "user",
        type: "text",
        content: wrappedMessage,
        synthetic: true,
      },
      parts: [{ type: "text", text: wrappedMessage }],
    })
  }
  // Don't transition to "stopped" — keep agent running
  return
}
```

### 3. `packages/opencode/src/session/prompt.ts` — Pass sessionID to status logic

**Location:** Where session status is checked

```typescript
// Ensure sessionID is passed to status logic for the hook
const status = yield* checkStatus(sessionID, ...)
```

## Plugin Usage Example

```typescript
// Prevent agent from stopping if progress.md hasn't been updated
"session.stopping": async (input, output) => {
  if (input.reason === "idle") {
    const progressExists = await fileExists("progress.md")
    if (!progressExists) {
      output.stop = false
      output.message = "You haven't updated progress.md yet — continue working."
    }
  }
}
```

## OpenChamber Impact Assessment

| File | Change Type | Impact |
|------|-------------|--------|
| `packages/plugin/src/index.ts` | New optional hook definition | **None** — optional hook is backward-compatible |
| `packages/opencode/src/session/status.ts` | Internal status transition logic | **None** — not exported |
| `packages/opencode/src/session/prompt.ts` | Internal call site update | **None** — not exported |

**Risk Level:** Very Low

## Success Criteria

- [ ] Plugin can return `{ stop: false }` from `session.stopping`
- [ ] Agent continues running when plugin returns `stop: false`
- [ ] Optional message is injected as synthetic user message
- [ ] Message is wrapped in `<system-reminder>` tags
- [ ] OpenChamber type-check passes
- [ ] OpenChamber build succeeds

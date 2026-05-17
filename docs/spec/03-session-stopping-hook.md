---
feature: session-stopping-hook
version: 1.0.0
status: implemented
source: architect/spec.md (Patch 2, PR #16598)
pr: anomalyco/opencode#16598
implementation: done
---

# Spec: session.stopping hook

## Implementation Status

| Status | Description |
|--------|-------------|
| **Status** | ✅ **Implemented** — Merged in better-opencode fork |
| **Source** | PR #16598 (unmerged upstream; implemented locally) |
| **Session** | `260520-1421-session-stopping-hook` |

## Problem Statement

Plugins cannot intercept the agent's idle/stop state. When the agent naturally stops (e.g., after completing a task), there is no mechanism to inject a follow-up message and keep the agent running. This prevents patterns like "You haven't updated progress.md yet — continue working."

## Design Decision

**A new `session.stopping` hook is added that fires before the agent loop exits in `runLoop` (prompt.ts), NOT in status.ts.**

**Rationale:**
- Minimal change to existing session status logic
- Complements PR #19519: #19519 handles mid-session reminders; #16598 handles session-end interception
- If the hook sets `output.stop = false` and provides `output.message`, the agent continues instead of stopping
- If a message is provided, it is injected via `flushInjectedMessages` with `role: "system"` (automatically wrapped in `<system-reminder>` tags)
- `status.ts` only manages state transitions (set/get); the actual loop exit lives in `prompt.ts`'s `runLoop`

## Files Modified

| File | Lines Added | Lines Removed |
|------|-------------|---------------|
| `packages/plugin/src/index.ts` | ~20 | 0 |
| `packages/opencode/src/session/prompt.ts` | ~37 | 1 |

**Total:** ~57 lines added, 1 line removed

## Implementation Details

### 1. `packages/plugin/src/index.ts` — Add session.stopping hook definition

**Location:** After existing hooks (~line 334)

```typescript
/**
 * Called before the agent loop exits. Set `output.stop = false` and
 * provide `output.message` to inject a user message and continue the loop.
 *
 * - `reason`: Why the session is stopping ("idle" = natural completion)
 * - `stop`: Defaults to `true`. Set to `false` to prevent exit.
 * - `message`: Required when `stop = false`. Injected as a synthetic
 *   user message wrapped in `<system-reminder>` tags.
 */
"session.stopping"?: (
  input: {
    sessionID: string
    reason: "idle"
  },
  output: {
    stop: boolean
    /** Required when stop = false. Injected as synthetic user message. */
    message?: string
  },
) => Promise<void>
```

### 2. `packages/opencode/src/session/prompt.ts` — Trigger hook before loop exit

**Location:** In `runLoop`, replacing the exit block (~lines 1788-1796)

**Before:**
```typescript
if (
  lastAssistant?.finish &&
  !["tool-calls"].includes(lastAssistant.finish) &&
  !hasToolCalls &&
  lastUser.id < lastAssistant.id
) {
  yield* slog.info("exiting loop")
  break
}
```

**After:**
```typescript
if (
  lastAssistant?.finish &&
  !["tool-calls"].includes(lastAssistant.finish) &&
  !hasToolCalls &&
  lastUser.id < lastAssistant.id
) {
  // Before exiting, check if plugin wants to continue
  const stoppingResult = yield* plugin.trigger(
    "session.stopping",
    { sessionID, reason: "idle" },
    { stop: true },
  )

  if (stoppingResult.stop === false) {
    // Guard: enforce message requirement
    if (!stoppingResult.message) {
      yield* slog.warn(
        "session.stopping hook returned stop=false without message — ignoring",
      )
      yield* slog.info("exiting loop")
      break
    }

    // Guard: enforce max continuation limit
    if (stoppingContinuationCount >= maxStoppingContinuations) {
      yield* slog.warn(
        `session.stopping hook prevented exit ${maxStoppingContinuations} times — forcing stop`,
      )
      yield* slog.info("exiting loop")
      break
    }

    // Inject the message and continue the loop
    stoppingContinuationCount++
    yield* flushInjectedMessages({
      injected: [{ role: "system", text: stoppingResult.message }],
      sessionID,
      agent: lastUser.agent,
      providerID: lastUser.model.providerID,
      modelID: lastUser.model.modelID,
    })

    yield* slog.info(
      "session.stopping hook prevented exit (continuation %d/%d)",
      stoppingContinuationCount,
      maxStoppingContinuations,
    )
    continue  // Don't break — continue the loop
  }

  yield* slog.info("exiting loop")
  break
}
```

### 3. Infinite Loop Guard

**Problem:** If a plugin always returns `stop: false` without resolving the condition, the agent loops forever.

**Solution:** Two-layer guard:

| Layer | Mechanism | Effect |
|-------|-----------|--------|
| **Message required** | `stop: false` without `message` is rejected | Prevents silent re-processing of same conversation |
| **Max continuations** | Counter tracks hook-triggered continuations per session | After 3 continuations, forces stop with warning |

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
| `packages/opencode/src/session/prompt.ts` | Internal loop exit logic | **None** — internal, not exported |

**Risk Level:** Very Low — optional hook, no breaking changes, guarded against infinite loops

## Success Criteria

- [x] Plugin can return `{ stop: false }` from `session.stopping`
- [x] Agent continues running when plugin returns `stop: false`
- [x] Optional message is injected as synthetic user message
- [x] Message is wrapped in `<system-reminder>` tags
- [x] OpenChamber type-check passes
- [x] OpenChamber build succeeds

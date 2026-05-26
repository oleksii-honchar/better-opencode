---
feature: tui-worker-globalbus-listener-cleanup
version: 1.3.0
status: implemented
source: researcher session 260526-2144-max-listeners
pr: TBD
implementation: complete
---

# Spec: TUI Worker GlobalBus Listener Cleanup

## Problem Statement

**The TUI worker module attaches a `GlobalBus.on("event", handler)` listener at module scope (line 43 of `worker.ts`) that is never removed.** The `shutdown()` method disposes instances and stops the server but does not remove the GlobalBus listener. When 10 SSE connections are active concurrently alongside the worker's permanent listener, 11 total listeners exceed Node.js's default `EventEmitter` limit of 10, and the warning fires:

```
MaxListenersExceededWarning: Possible EventTarget memory leak detected. 11 event listeners added to [GlobalBusEmitter]. MaxListeners is undefined.
```

## Root Cause

The 11 listeners are the sum of:
- **1 permanent worker listener** (module-scoped, never removed) — `worker.ts:43`
- **Up to 10 SSE connection listeners** (properly cleaned up via `acquire/release`) — `handlers/global.ts:41`

Node.js `EventEmitter` default maxListeners is 10. The `_maxListeners` on `GlobalBusEmitter` was `undefined`, so it inherited the default. When 10 SSE connections are active simultaneously, 1 + 10 = 11 > 10, triggering the warning.

| Source | Location | Attach? | Cleanup? | Status |
|--------|----------|---------|----------|--------|
| TUI Worker | `cli/cmd/tui/worker.ts:43` | Yes, module scope | **No** (before fix) | **FIXED** |
| SSE Endpoint | `handlers/global.ts:41` | Yes, per-connection | Yes, on disconnect | OK |
| Control Plane | `control-plane/util.ts:35` | Yes, per-call | Yes, on resolve/timeout | OK |

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Thread (main process)                           │
│                                                  │
│  TuiThreadCommand handler                        │
│    spawns Worker (worker.ts)                      │
│    on SIGUSR2: calls client.call("reload")        │
│    on stop:       calls client.call("shutdown")   │
└────────────────┬─────────────────────────────────┘
                  │ RPC
                  ▼
┌──────────────────────────────────────────────────┐
│  Worker (worker.ts) — Node.js Worker thread       │
│                                                  │
│  Module init:                                    │
│    GlobalBus.on("event", handleGlobalEvent)      │
│    ──> named handler, can be removed via off()   │
│                                                  │
│  reload() RPC:                                   │
│    disposeAllInstancesAndEmitGlobalDisposed       │
│    ──> listener stays (still needed after reload)│
│                                                  │
│  shutdown() RPC:                                 │
│    InstanceRuntime.disposeAllInstances()          │
│    server?.stop()                                 │
│    removeGlobalEventListener() ← NEW             │
│    ──> removes GlobalBus listener on shutdown    │
│                                                  │
│  Thread termination:                              │
│    worker.terminate() (from thread.ts)            │
│    ──> module scope listeners die with thread     │
└──────────────────────────────────────────────────┘

Also:
  SSE connections: up to 10 concurrent, each with acquire/release cleanup
```

## Design Decision

**Two-part fix: (1) setMaxListeners(0) on GlobalBus, (2) named handler + shutdown cleanup in worker.**

### Why setMaxListeners(0)?

The primary issue is that 1 permanent + 10 SSE = 11 exceeds Node's default limit of 10. Setting `setMaxListeners(0)` (no limit) is appropriate because:
- GlobalBus is a low-level infrastructure component with 3 known consumers
- All consumers properly manage listener lifecycle
- The event system is not designed to scale to thousands of listeners; it's a simple pub/sub
- Memory risk from listener accumulation is minimal (handler functions are lightweight closures)

### Approach: Named function + shutdown cleanup

```typescript
// cli/cmd/tui/worker.ts
import { GlobalBus, type GlobalEvent } from "@/bus/global"

// Named handler function (exported for external cleanup)
function handleGlobalEvent(event: GlobalEvent): void {
  Rpc.emit("global.event", event)
}

// Attach once at module initialization
GlobalBus.on("event", handleGlobalEvent)

export function removeGlobalEventListener(): void {
  GlobalBus.off("event", handleGlobalEvent)
}

export const rpc = {
  async shutdown() {
    Log.Default.info("worker shutting down")

    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)

    // NEW: Remove the GlobalBus listener
    removeGlobalEventListener()
  },
  // ... other rpc methods
}
```

### Why Named Function?

The existing anonymous arrow function `(event) => { ... }` cannot be removed with `off()` because `off()` requires the same function reference. By extracting the handler to a named function (`handleGlobalEvent`), we can pass the same reference to both `on()` and `off()`.

### Why Only `shutdown()` Cleanup (Not `reload()`)?

The `reload()` call is designed to reset instance context without killing the worker thread. The GlobalBus listener is process-scoped and does not need to be removed between reloads — it should persist across reloads because:

1. The global event forwarding (`Rpc.emit("global.event", event)`) is still needed after reload
2. The thread remains alive, so the listener is still valid
3. Only actual shutdown/termination requires cleanup

## Implementation Details

### 1. `packages/opencode/src/bus/global.ts`

**Change:** Add `setMaxListeners(0)` with documentation.

```typescript
export const GlobalBus = new GlobalBusEmitter()

// No max listener limit — listeners are managed by consumers:
// - worker: permanent (1), removed on shutdown
// - SSE: acquire/release per connection
// - control-plane: Effect.callback with explicit cleanup
GlobalBus.setMaxListeners(0)
```

### 2. `packages/opencode/src/cli/cmd/tui/worker.ts`

**Changes:**
- Add `type GlobalEvent` to import from `@/bus/global`
- Extract the anonymous handler to a named function `handleGlobalEvent`
- Add `removeGlobalEventListener()` export
- Call cleanup in `shutdown()`

```typescript
// Before:
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

export const rpc = {
  async shutdown() {
    Log.Default.info("worker shutting down")
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
  },
}

// After:
import { GlobalBus, type GlobalEvent } from "@/bus/global"

function handleGlobalEvent(event: GlobalEvent): void {
  Rpc.emit("global.event", event)
}

GlobalBus.on("event", handleGlobalEvent)

export function removeGlobalEventListener(): void {
  GlobalBus.off("event", handleGlobalEvent)
}

export const rpc = {
  async shutdown() {
    Log.Default.info("worker shutting down")
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    removeGlobalEventListener()
  },
}
```

## Success Criteria

- [x] `GlobalBus.on` handler in worker.ts is a named function (not anonymous)
- [x] `removeGlobalEventListener()` is exported from worker.ts
- [x] `shutdown()` RPC calls `removeGlobalEventListener()`
- [x] No `MaxListenersExceededWarning` after 10+ concurrent SSE connections
- [x] `setMaxListeners(0)` set on GlobalBus with documentation
- [x] No other GlobalBus.on() sites lack cleanup
- [x] TypeScript compilation clean

## Open Decisions

| Decision | Value | Rationale |
|----------|-------|----------|
| Named function vs. reference tracking | Named function | Simpler, no extra data structure needed, works with Node's native on/off |
| Cleanup in shutdown only vs. reload | shutdown only | Reload keeps the thread alive and listener is still valid; only shutdown requires cleanup |
| `setMaxListeners` value | 0 (no limit) | All consumers have proper cleanup; 0 is Node's documented convention for "no limit" |
| Expose cleanup API | Yes, exported | Allows thread.ts to call it directly if needed; no side effects if unused |

## Files Modified

| File | Change |
|------|--------|
| `packages/opencode/src/bus/global.ts` | Add `GlobalBus.setMaxListeners(0)` with documentation |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | Extract handler to named function, add `removeGlobalEventListener()`, call in `shutdown()`, add `type GlobalEvent` import |

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Cleanup called twice (shutdown then terminate) | Medium | `off()` is idempotent on Node.js — calling `off()` with a handler not on the list is a no-op |
| Named function hoisting issues | Low | Function declaration hoists before module execution; safe |
| `setMaxListeners(0)` hides real leaks | Low | All 3 consumer patterns already use proper cleanup; code review for new consumers |
| `removeGlobalEventListener` unused in thread.ts | Low | Export is for potential future use; no side effects |

## Bug History

| Date | Session | Issue | Fix |
|------|---------|-------|-----|
| 2026-05-26 | 260526-2144-max-listeners | MaxListenersExceededWarning on GlobalBusEmitter (11 listeners: 1 worker + 10 SSE) | Named handler + cleanup on shutdown + setMaxListeners(0) |

## Session

- **Research session:** 260526-2144-max-listeners (May 26, 2026)
- **Source findings:** `~/.agent-sessions/26/05/26/260526-2144-max-listeners/findings.md`
- **Architect artifacts:** `~/.agent-sessions/26/05/26/260526-2144-max-listeners/spec.md`

---
feature: system-prompt-persistence
version: 2.0.0
status: spec
source: session/260608-1830-chat-context-history/spec.md
pr: N/A (to be created)
implementation: pending
---

# Spec: Complete System Prompt Persistence via Callback Pattern

**Version 2.0.0** — Redesigned to capture the complete, final system prompt (including agent persona, user system, and plugin transforms). See [v1.0.0 changelog](#changelog) below.

## Problem Statement

The system prompt in better-opencode is composed at runtime and injected into the LLM API request, but is **never persisted** in the SQLite database. Only user and assistant messages are stored.

This creates limitations:
- The system prompt is invisible in session history / UI
- Sessions cannot be replayed with their original system prompt
- Session export is incomplete (missing the system prompt)
- No way to audit which system prompt was active for a given session

**Critical issue discovered in v1:** The initial design persisted only a **partial** system prompt — `env + instructions + skills + file attachments + structured output` — missing the **agent persona** (`agent.prompt`), **user system prompt** (`user.system`), and **plugin transforms**. These are added in the LLM request preparation layer (`llm/request.ts`'s `prepare()`), after the persistence point.

## Design Decision

**Use a callback pattern to capture the complete, final system prompt from the LLM request preparation layer where it's fully composed, then persist it back in the calling layer.**

Add an `onSystemPrepared` callback to `prepare()` that is invoked AFTER the final system prompt is composed (including plugin transforms). The callback persists the prompt as a synthetic, `ignored: true` TextPart attached to the first user message.

## Architecture

### Two-Layer Composition Problem

The system prompt is composed in **two layers**:

```
Layer 1 — runLoop() (prompt.ts):
  system = [...env, ...instructions, ...skills, ...fileAttachments, ...structuredOutput]
  
Layer 2 — prepare() (llm/request.ts):
  finalSystem = [agent.prompt || providerPrompt, ...input.system, user.system]
  plugin.transform(finalSystem)  ← post-composition hook
```

**v1 mistake:** Persisted at Layer 1 → missing agent.prompt, user.system, and plugin transforms.

**v2 fix:** Callback from Layer 2 → captures the EXACT prompt the LLM receives.

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                      runLoop() (prompt.ts)                   │
│                                                             │
│  Step 1: msgs = filterCompactedEffect(sessionID)    ← DB    │
│  Step 2: toModelMessagesEffect(msgs, model)                │
│  Step 3: system = [...env, ...instructions, ...skills]      │
│  Step 4: handle.process({                                  │
│            system,                                          │
│            onSystemPrepared: (finalSystem) => {             │
│              yield* sessions.updatePart({                   │
│                id: PartID.ascending(),                      │
│                messageID: lastUser.id,                      │
│                sessionID,                                   │
│                type: "text",                                │
│                text: finalSystem,     ← COMPLETE prompt     │
│                synthetic: true,                             │
│                ignored: true,                               │
│                metadata: { systemPrompt: true },            │
│              })                                             │
│            },                                               │
│          })                                                 │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│                     LLM layer (llm.ts)                       │
│                                                             │
│  const prepared = yield* LLMRequestPrep.prepare({           │
│    ...input,                                                │
│    onSystemPrepared: input.onSystemPrepared,   ← callback   │
│  })                                                         │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│             prepare() (llm/request.ts) — THE COMPOSITION     │
│                                                             │
│  const system = [                                           │
│    agent.prompt || providerPrompt,  ← ✅ CAPTURED           │
│    ...input.system,         ← ✅ CAPTURED (env+instr+...)   │
│    user.system,              ← ✅ CAPTURED                  │
│  ].filter(x => x).join("\n")                                │
│                                                             │
│  yield* plugin.trigger("experimental.chat.system.transform",│
│    { system })     ← ✅ CAPTURED AFTER TRANSFORM           │
│                                                             │
│  if (input.onSystemPrepared) {                              │
│    yield* input.onSystemPrepared(system[0])  ← callback     │
│  }                                                          │
│                                                             │
│  return { system, messages, tools, params, ... }            │
└─────────────────────────────────────────────────────────────┘
```

### Why `ignored: true` is Correct

The `ignored` flag is the critical mechanism that makes this approach work:

| Filter Location | Code | Effect |
|----------------|------|--------|
| `toModelMessages` (message-v2.ts:704) | `!part.ignored` | Part NOT sent to LLM |
| UI (app/src/utils/prompt.ts:44) | `!part.ignored` | Part NOT shown in chat view |
| Loop (prompt.ts:1548) | `p.ignored` | Part NOT re-processed by loop |
| PartTable DB | — | Part IS stored in database |

**Timing safety:**

The callback is invoked inside `prepare()` after the final system prompt is composed. The part is created via the callback before the LLM call:

- **First LLM call:** Part created via callback, but `ignored: true` → not sent to LLM. LLM receives system prompt via `system` array — **no duplication**.
- **Subsequent LLM calls:** Part exists in DB, loaded in Step 1, but `ignored: true` → filtered out — **no duplication**.

## Data Model

### PartTable Row (no schema change)

```json
{
  "id": "part_xxx",
  "message_id": "msg_xxx",
  "session_id": "session_xxx",
  "data": {
    "type": "text",
    "text": "You are an expert software engineer...\n<env>\n  Working directory: ...\n</env>",
    "synthetic": true,
    "ignored": true,
    "metadata": {
      "systemPrompt": true
    }
  }
}
```

**KEY DIFFERENCE FROM v1:** The `text` field now contains the COMPLETE system prompt (agent persona + env + instructions + user system + plugin transforms), not just the partial `composedSystem` from `prompt.ts`.

### Query to Retrieve

```sql
SELECT data FROM part
WHERE session_id = ?
  AND data->>'type' = 'text'
  AND data->'metadata'->>'systemPrompt' = 'true'
```

## Implementation Details

### File Change Summary

| File | Lines Added | Lines Removed | Change Type |
|------|-------------|---------------|-------------|
| `packages/opencode/src/session/llm/request.ts` | +5 | 0 | Add callback to PrepareInput, invoke after transform |
| `packages/opencode/src/session/llm.ts` | +3 | 0 | Add to StreamInput, pass through to prepare() |
| `packages/opencode/src/session/prompt.ts` | +12 | -11 | Replace inline persistence with callback |
| **Total** | **+20** | **-11** | **Net +9 lines** |

### Phase 1: Add Callback to prepare()

**File:** `packages/opencode/src/session/llm/request.ts`

```diff
  type PrepareInput = {
    // ... existing fields ...
+   readonly onSystemPrepared?: (system: string) => Effect.Effect<void, never, never>
  }

  export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
    // ... existing composition (unchanged) ...
    yield* input.plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )

+   // Notify caller of the final composed system prompt (after plugin transform)
+   if (input.onSystemPrepared) {
+     yield* input.onSystemPrepared(system[0])
+   }

    // ... rest of prepare (unchanged) ...
  })
```

### Phase 2: Thread Callback Through LLM Layer

**File:** `packages/opencode/src/session/llm.ts`

```diff
  export type StreamInput = {
    // ... existing fields ...
+   onSystemPrepared?: (system: string) => Effect.Effect<void, never, never>
  }
```

```diff
       const prepared = yield* LLMRequestPrep.prepare({
         ...input,
         provider: item,
         auth: info,
         plugin,
         flags,
         isWorkflow,
+        onSystemPrepared: input.onSystemPrepared,
       })
```

### Phase 3: Wire Callback in prompt.ts

**File:** `packages/opencode/src/session/prompt.ts`

Replace the current incomplete persistence with the callback approach:

```diff
-           // Persist system prompt as a synthetic ignored part (only step 1)
-           if (step === 1) {
-             yield* sessions.updatePart({
-               id: PartID.ascending(),
-               messageID: lastUser.id,
-               sessionID,
-               type: "text",
-               text: composedSystem,
-               synthetic: true,
-               ignored: true,
-               metadata: { systemPrompt: true },
-             } satisfies MessageV2.TextPart)
-           }
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
              tools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
+             onSystemPrepared: step === 1
+               ? (finalSystem: string) =>
+                   sessions.updatePart({
+                     id: PartID.ascending(),
+                     messageID: lastUser.id,
+                     sessionID,
+                     type: "text",
+                     text: finalSystem,
+                     synthetic: true,
+                     ignored: true,
+                     metadata: { systemPrompt: true },
+                   } satisfies MessageV2.TextPart)
+               : undefined,
            })
```

**Dependencies (all already in scope):**
- `PartID` — already imported (used throughout for part creation)
- `sessions.updatePart` — already in scope (used throughout `prompt.ts`)
- `lastUser.id` — already in scope (the first user message of the session)
- `MessageV2.TextPart` — already imported via `MessageV2` namespace

### Phase 4: Add Callback to Process Input Type

Add `onSystemPrepared` to the process input type used by `handle.process()`. The exact location depends on how `handle.process()` maps to `StreamInput`. If `handle.process()` passes through to `StreamInput`, the Phase 2 change may be sufficient.

## Alternative Approaches Considered

### Duplicate Composition in prompt.ts (rejected)

Add `agent.prompt` and `user.system` to the system array in `prompt.ts`:

```typescript
const system = [
  agent.prompt ?? providerPrompt,
  ...env, ...instructions, ...skills,
  lastUser.system,
].filter(x => x).join("\n")
```

**Pros:** Minimal change (one file, fewer lines).

**Cons:**
- **Code duplication** — two composition sites that can diverge
- **Plugin transforms not captured** — `experimental.chat.system.transform` runs AFTER composition in `prepare()`
- **Fundamentally unreliable** — if persisted prompt ≠ actual prompt, the feature misleads

**Verdict:** Rejected. The duplication risk and missing plugin transforms make this approach unreliable for capturing the EXACT system prompt the LLM receives.

### SessionTable Column (rejected)

Add a `system_prompt: text()` column to SessionTable, persist at `prepare()` time.

**Why rejected:** DB migration required, wrong composition point, service coupling between LLM layer and DB schema.

### Extract Shared Composition Function (rejected)

Create `composeSystemPrompt()` used by both layers.

**Why rejected:** Plugin transform still happens after composition in `prepare()`. The shared function would produce the pre-transform prompt.

## OpenChamber Impact Assessment

| File | Change Type | Impact |
|------|-------------|--------|
| `request.ts` | Add optional callback to PrepareInput | **None** — internal, optional parameter |
| `llm.ts` | Add optional field to StreamInput, pass through | **None** — internal, optional parameter |
| `prompt.ts` | Replace inline persistence with callback | **None** — internal server code |

**Risk Level:** Very Low — no schema changes, no API changes, no client-side code changes. The callback is optional and doesn't affect existing callers.

## Success Criteria

- [ ] Complete system prompt (including agent.prompt, user.system, and plugin transforms) is persisted in PartTable
- [ ] Persisted prompt matches the exact system prompt the LLM receives (verifiable by comparison)
- [ ] System prompt is retrievable via SQL query with `metadata->>'systemPrompt' = 'true'`
- [ ] System prompt does NOT appear in `toModelMessages` output (verified by `ignored: true`)
- [ ] System prompt does NOT appear in the UI chat view (verified by `ignored: true`)
- [ ] No LLM duplication (system prompt sent only once per call)
- [ ] No schema changes required (no DB migration)
- [ ] Existing sessions are unaffected (no system prompt for them)
- [ ] Plugin transforms are captured (verify with a test plugin that modifies the system prompt)

## Open Decisions

| Decision | Options | Default |
|----------|---------|---------|
| Update frequency | First message only vs. every message | First message only (env block would change each call) |
| Store env block | Yes (current) vs. No | Yes (captures exact prompt used) |
| Structured sources | Flat text vs. structured JSON | Flat text (structured can be added later) |

## Changelog

### v2.0.0 (2026-06-08) — Callback Pattern Redesign

**Problem:** v1.0.0 persisted an incomplete system prompt (missing agent persona, user system, and plugin transforms) because composition happens in two layers.

**Changes:**
- Redesigned to use a callback pattern (`onSystemPrepared`) from `prepare()` to capture the complete, final system prompt
- Added `onSystemPrepared` callback to `PrepareInput` in `llm/request.ts`
- Threaded callback through `llm.ts` (`StreamInput`)
- Replaced inline persistence in `prompt.ts` with callback
- Persisted prompt now includes: agent.prompt, provider prompt, env, instructions, skills, file attachments, structured output, user.system, AND plugin transforms

**Impact:** The persisted system prompt now accurately reflects the EXACT prompt the LLM receives, including all composition layers and plugin transforms.

### v1.0.0 (2026-06-08) — Initial Design

**Problem:** System prompt not persisted at all.

**Solution:** Persist `composedSystem` from `prompt.ts` as a synthetic, `ignored: true` TextPart.

**Issue:** Only captured partial system prompt (missing agent.prompt, user.system, and plugin transforms). See `findings-agent-persona.md` for details.

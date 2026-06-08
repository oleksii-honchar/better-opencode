---
feature: system-prompt-persistence
version: 1.0.0
status: spec
source: session/260608-1830-chat-context-history/spec.md
pr: N/A (to be created)
implementation: pending
---

# Spec: System Prompt Persistence via PartTable

## Problem Statement

The system prompt in better-opencode is composed at runtime and injected into the LLM API request, but is **never persisted** in the SQLite database. Only user and assistant messages are stored.

This creates limitations:
- The system prompt is invisible in session history / UI
- Sessions cannot be replayed with their original system prompt
- Session export is incomplete (missing the system prompt)
- No way to audit which system prompt was active for a given session

## Design Decision

**Store the composed system prompt as a synthetic, `ignored: true` TextPart attached to the first user message in the session.**

No schema changes, no new types, ~8 lines of code in one file. Uses the existing `ignored` flag mechanism to keep the part invisible to the LLM, UI, and loop processing while still being persisted in the database.

## Architecture

### Current State (Before)

```
Session prompt.ts:runLoop():
  Step 1: msgs = filterCompactedEffect(sessionID)     ← loads user/assistant messages from DB
  Step 2: toModelMessagesEffect(msgs, model)          ← converts to LLM format
  Step 3: system = [...env, ...instructions, ...skills] ← composes system prompt (runtime only)
  Step 4: handle.process({ system, messages: modelMsgs }) ← sends to LLM

Database:
  SessionTable:  id, parent_id, title, agent, model, workspace_folders, ...
  MessageTable:  id, session_id, data (role: user | assistant)
  PartTable:     id, message_id, session_id, data (TextPart, ToolPart, ...)

System prompt:  NOT STORED  ← gap
```

### After Implementation

```
Session prompt.ts:runLoop():
  Step 1: msgs = filterCompactedEffect(sessionID)     ← loads user/assistant messages from DB
  Step 2: toModelMessagesEffect(msgs, model)          ← converts to LLM format
  Step 3: system = [...env, ...instructions, ...skills] ← composes system prompt
  Step 4: [PERSIST SYSTEM PROMPT] ← only step === 1, via sessions.updatePart()
  Step 5: handle.process({ system, messages: modelMsgs }) ← sends to LLM

Database:
  SessionTable:  id, parent_id, title, agent, model, workspace_folders, ...
  MessageTable:  id, session_id, data (role: user | assistant)
  PartTable:     id, message_id, session_id, data (TextPart, ToolPart, ...)
                    └─ NEW: TextPart with ignored: true, metadata.systemPrompt: true

System prompt:  STORED in PartTable  ← gap closed
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

The part is created at Step 4, AFTER `toModelMessages` runs (Step 2):

- **First LLM call:** Part created AFTER Step 2 → not in messages array. LLM receives system prompt only via `system` array — **no duplication**.
- **Subsequent LLM calls:** Part exists in DB, loaded in Step 1, but `ignored: true` → filtered out — **no duplication**.
- If `ignored` were `false` and part created BEFORE `toModelMessages`: **duplication** — LLM receives system prompt as `role: "system"` AND as text in user message.

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

### Query to Retrieve

```sql
SELECT data FROM part
WHERE session_id = ?
  AND data->>'type' = 'text'
  AND data->'metadata'->>'systemPrompt' = 'true'
```

## Implementation Details

### File Modified

| File | Lines Added | Lines Removed |
|------|-------------|---------------|
| `packages/opencode/src/session/prompt.ts` | +11 | 0 |

### Implementation

**`packages/opencode/src/session/prompt.ts`** (insertion point: after system prompt composition, before `handle.process()`, only on `step === 1`):

```typescript
const system = [
  ...env,
  ...instructions,
  ...(hasMessageAttachments(lastUser.id) ? [FILE_ATTACHMENTS_SYSTEM_PROMPT] : []),
  ...(skills ? [skills] : []),
]
const composedSystem = system.join("\n")

// Persist system prompt as a synthetic ignored part on the first user message (only step 1)
if (step === 1) {
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: lastUser.id,
    sessionID,
    type: "text",
    text: composedSystem,
    synthetic: true,
    ignored: true,
    metadata: { systemPrompt: true },
  } satisfies MessageV2.TextPart)
}
```

**Dependencies (all already in scope):**
- `PartID` — already imported (used throughout for part creation)
- `sessions.updatePart` — already in scope (used throughout `prompt.ts`)
- `lastUser.id` — already in scope (the first user message of the session)
- `MessageV2.TextPart` — already imported via `MessageV2` namespace

## Alternative Approaches Considered

### Option 3: SessionTable Column (rejected)

Add a `system_prompt: text()` column to SessionTable, persist at `prepare()` time.

**Why rejected:**
1. **DB migration required** — The `workspace_folders` column (added in spec/10) required a multi-file migration with client-side SDK workarounds. This would need the same treatment.
2. **Wrong prompt stored** — The system prompt is composed in two places with different content:
   - `runLoop()`: env + instructions + FILE_ATTACHMENTS_SYSTEM_PROMPT + skills + STRUCTURED_OUTPUT_SYSTEM_PROMPT
   - `prepare()`: agent.prompt + system (from runLoop) + user.system
   
   Persisting at `prepare()` time stores a slightly different prompt than what was actually used by the LLM.
3. **Service coupling** — `prepare()` in `llm.ts` doesn't have Session service — requires `Database.use()` directly, coupling the LLM layer to the DB schema.

### Option B: New SystemPromptPart Type (rejected)

Create a new `SystemPromptPart` type with structured source data.

**Why rejected:** Over-engineered for current use case. Requires schema change (new type in Part union), changes in 4 files, UI must handle new type. Option A is sufficient and simpler.

## OpenChamber Impact Assessment

| File | Change Type | Impact |
|------|-------------|--------|
| `prompt.ts` | Part creation in runLoop | **None** — internal server code, no client-facing API |

**Risk Level:** Very Low — no schema changes, no API changes, no client-side code changes.

## Success Criteria

- [ ] System prompt is persisted in PartTable on first user message
- [ ] System prompt is retrievable via SQL query with `metadata->>'systemPrompt' = 'true'`
- [ ] System prompt does NOT appear in `toModelMessages` output (verified by `ignored: true`)
- [ ] System prompt does NOT appear in the UI chat view (verified by `ignored: true`)
- [ ] No LLM duplication (system prompt sent only once per call)
- [ ] No schema changes required (no DB migration)
- [ ] Existing sessions are unaffected (no system prompt for them)

## Open Decisions

| Decision | Options | Default |
|----------|---------|---------|
| Update frequency | First message only vs. every message | First message only (env block would change each call) |
| Store env block | Yes (current) vs. No | Yes (captures exact prompt used) |
| Structured sources | Flat text vs. structured JSON | Flat text (structured can be added later) |

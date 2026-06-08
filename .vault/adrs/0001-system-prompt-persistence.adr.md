---
type: adr
id: ADR-0001
title: "Persist System Prompt in Session Database"
status: proposed
createdAt: "2026-06-08T21:00:00Z"
updatedAt: "2026-06-08T21:00:00Z"
tags: [system-prompt, persistence, database, session-storage]
see_also:
  - "architectures/better-opencode/components/0001-session-storage.component.md"
  - "concepts/0002-system-prompt.concept.md"
  - "concepts/0001-session-model.concept.md"
---

# ADR-0001: Persist System Prompt in Session Database

## Context

The system prompt in better-opencode is composed at runtime and injected as part of the LLM API request. It is **never stored** in the SQLite database — only user and assistant messages are persisted.

This creates limitations:
- The system prompt is invisible in session history / UI
- Sessions cannot be replayed with their original system prompt
- Session export is incomplete (missing the system prompt)

### Current State

| Content | Persisted? | How |
|---------|-----------|-----|
| Full system prompt | **No** | Runtime-only, injected at LLM request time |
| User messages | Yes | `messages` table, role=user |
| Assistant messages | Yes | `messages` table, role=assistant |
| `User.system` field | Yes (but limited) | As `system` field in `MessageTable.data` JSON — only stores the user-provided system text, not the full composed prompt |
| Injected system messages (tool hooks) | Yes | As **user** messages wrapped in `<system-reminder>` tags |

### Composition Flow

The system prompt is assembled in `LLMRequestPrep.prepare()` (`session/llm/request.ts:54`):

```
Step 1: agent.prompt ?? provider_specific_prompt(model)
Step 2: ...user instruction files (AGENTS.md, CLAUDE.md, etc.)
Step 3: ...user.message.system (from User.system field)
Step 4: Plugin transform hook ("experimental.chat.system.transform")
```

The composed prompt reaches the LLM via one of three delivery modes:
- **Standard API**: Prepended as `role: "system"` messages
- **OpenAI OAuth**: Set as `options.instructions`
- **GitLab workflow**: Set as `workflowModel.systemPrompt`

## Decision

**Add a `system_prompt` text column to the `SessionTable` and persist the composed system prompt at `prepare()` time.**

This corresponds to Option 3 from the analysis below (simple text column on SessionTable).

### Rationale

- The primary use case (displaying the system prompt in UI / exporting sessions) needs the final composed text
- The `prepare()` function is the single place where the full system prompt is assembled
- Minimal schema change (one text column)
- Can always be enhanced later with structured sources if needed

### Implementation Outline

```diff
// session.sql.ts
export const SessionTable = sqliteTable(
  "session",
  {
    // ... existing fields
+   system_prompt: text(),  // Full composed system prompt for this session
  },
)
```

```diff
// llm/request.ts
export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

+ // Persist system prompt to session (only on first message)
+ if (!input.user.id.startsWith("msg_compact")) {
+   yield* Session.update({
+     id: input.sessionID,
+     system_prompt: system[0],
+   })
+ }
  // ... rest of prepare
```

The persistence point is `request.ts:prepare()` — after the system prompt is assembled but before the LLM call. The system prompt is persisted only on the first user message of a session (detected by checking `!input.user.id.startsWith("msg_compact")`).

## Alternatives Considered

### Option 1: Store structured breakdown on SessionTable

Add a JSON `system_prompt` field with structured components (agent_prompt, provider, user_system, instructions, skills, environment, composed):

**Pros:** Captures full context for reconstruction; structured breakdown allows partial updates
**Cons:** Large JSON blob; environment block changes every request; requires DB migration

### Option 2: Store as first message in Message table

Insert a synthetic `role: "system"` message as the first message:

**Pros:** No schema change to SessionTable; visible in message history / UI
**Cons:** Requires extending the `Info` union type; `MessageTable` doesn't have `role: "system"`; breaks the user/assistant dichotomy; would need special handling in all message processing code

### Option 3: Store on SessionTable as simple text ✅ (selected)

Add a `system_prompt: text()` column:

**Pros:** Minimal schema change; easy to query and display; sufficient for replay/display purposes
**Cons:** Loses structured breakdown; no way to update individual components; still potentially large text field

### Option 4: Store instruction sources (not contents)

Store the file paths/versions that were used to compose the system prompt:

**Pros:** Small, structured, versionable; allows reconstruction by re-reading source files
**Cons:** Source files may have changed since composition (stale references); can't display the actual prompt without re-reading and recomposing

### Option 5: Hybrid — Store composed + sources

Combine Options 3 and 4 (composed text + source file paths):

**Pros:** Display-ready + reconstructible; sources provide audit trail
**Cons:** More columns to maintain; duplication (composed prompt can be derived from sources)

## Consequences

### Positive
- System prompt becomes visible in session history / UI
- Sessions can be exported with full context (system prompt + messages)
- Session replay becomes possible (re-inject the persisted system prompt)

### Negative
- Database migration required (add `system_prompt` column)
- `system_prompt` is a potentially large text field (provider prompt + instructions + skills can be kilobytes)
- The environment block (date, working directory, etc.) is captured at compose time — it may become stale

### Neutral
- The `User.system` field already exists in the `MessageTable.data` JSON — it stores only the user-provided system text, not the full composed prompt. The new `system_prompt` column on `SessionTable` would store the full composed prompt.

## Open Questions

- **Update frequency**: Should the system prompt be re-persisted on each message (to capture updated env block), or only on the first message?
- **Structured vs flat**: Could a future ADR refine this to store structured sources (Option 4/5) if partial updates become necessary?

---
type: adr
title: "Pass Original Session ID Through Plugin LLM Service"
status: accepted
date: "2026-07-13"
see_also:
  - "[[0047-expose-llm-service-to-plugins-via-plugininput.adr.md]]"
tags: [plugin, session-id, llm-service]
---

# Pass Original Session ID Through Plugin LLM Service

## Context

The plugin system created a synthetic session ID (`"plugin-" + crypto.randomUUID()`) for LLM calls. This fails `SessionID` schema validation — the schema in `packages/core/src/session.ts:7` requires a `"ses"` prefix.

## Decision

Pass the original session ID through the plugin LLM service interface:

1. Add optional `sessionId` parameter to `PluginLLMService.chatCompletionWithModel()` request
2. Use provided session ID in opencode's LLM service wrapper
3. Plugin passes `metaState.sessionId` from plugin startup

```
agent-meta-tool → PluginInput.llm.chatCompletionWithModel({
  messages: [...],
  model: "mammoth/qwen3.5-0.8b",
  sessionId: metaState.sessionId  // Original session ID
})
  → opencode LLM service wrapper
  → LLM.StreamInput with original session ID
  → No schema validation failure
```

## Alternatives Considered

1. **Fix synthetic ID prefix** — rejected (still creates fake session)
2. **Remove session ID requirement** — rejected (SessionID schema exists for valid reasons)
3. **Create "ses-" prefixed ID** — rejected (doesn't solve root problem of session tracking)

## Consequences

**Positive:** Session ID validation passes, proper session tracking, correct log context.

**Negative:** Requires `metaState.sessionId` to be populated — hard error if not provided (by design to catch missing configuration).
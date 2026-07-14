---
type: memory
title: "SessionID Schema Requires 'ses' Prefix — Synthetic IDs Fail"
status: accepted
date: "2026-07-13"
see_also:
  - "[[0050-pass-original-session-id.adr.md]]"
  - "[[0003-system-prompt-cache-invalidation.memory.md]]"
tags: [session-id, schema, plugin, gotcha]
---

# SessionID Schema Requires "ses" Prefix — Synthetic IDs Fail

## Fact

The `SessionID` Zod schema in `packages/core/src/session.ts:7` requires a `"ses"` prefix. Any synthetic session ID with a different prefix (e.g. `"plugin-" + crypto.randomUUID()`) will fail validation silently.

## Context

Discovered during agent-meta-tool plugin development — the plugin created a synthetic `"plugin-"` prefixed session ID for LLM calls. The `chatCompletionWithModel()` service silently failed validation.

## Impact

Future work involving plugin session IDs must either:
1. Pass the real `metaState.sessionId` (preferred — see ADR-0050)
2. Never create synthetic session IDs with non-"ses" prefixes

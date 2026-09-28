---
type: concept
title: "Session Stopping Hook — Turn-Interruption Delivery Primitive"
createdAt: "2026-09-28T10:00:00Z"
updatedAt: "2026-09-28T10:00:00Z"
tags: [plugin, hooks, session, turn-interruption, fork-feature, message-injection]
see_also:
  - "concepts/0003-llm-turn-management.concept.md"
superseded_by: []
deprecated:
  date: null
  reason: null
---

# Session Stopping Hook — Turn-Interruption Delivery Primitive

## What

A fork-specific plugin hook (`session.stopping`) that fires when the LLM loop is about to exit idle. Plugins can return `{stop: false, message: "..."}` to inject a fresh user-role message via the runtime's `flushInjectedMessages`, forcing the agent to respond to it before proceeding. This is the fork's proven turn-interruption delivery channel.

## Why

Standard tool hooks (`tool.execute.before`/`after`) deliver errors or nudge messages as parts of the same turn — non-authoritative to the LLM. A tool error is a recoverable result; the agent continues. The `session.stopping` hook provides a way to deliver authoritative, turn-level messages that the agent must respond to.

## How It Works

```typescript
// Plugin hook registration
plugin.hooks['session.stopping'] = async (ctx) => {
  // ctx.sessionID — the session that's about to idle
  if (shouldInterrupt(ctx.sessionID)) {
    return {
      stop: false,  // don't exit; inject message
      message: "Your authoritative message here"
    };
  }
  return { stop: true };  // allow idle exit
};
```

The runtime's `flushInjectedMessages` (in `packages/opencode/src/session/prompt.ts`) creates a `MessageV2.User` with `synthetic: true` and the provided text. The LLM loop treats it as a fresh user turn.

## Constraints

- **Bounded:** `maxStoppingContinuations = 3` — after 3 injected continuations, the runtime forces idle exit (fail-open)
- **Fork feature only:** Not in upstream opencode. Fork commits `3005c73d1` and `4cc6ba3b0`
- **Upstream PR pending:** #16598 — if merged, this becomes a standard feature
- **Provenance:** Originally requested for MCP filtering use case; now used for SOP enforcement

## Use Cases

1. **Hard-gate enforcement:** Interrupt agent mid-task to force decision-tree realignment (agent-persona-coach)
2. **MCP filtering:** Prevent session exit while processing queued tool calls (original fork use case)
3. **Any SOP enforcement:** Situations requiring the agent to acknowledge/respond before proceeding

## Evidence

Verified in better-opencode source:
- Hook trigger: `packages/opencode/src/session/prompt.ts:1495-1537`
- Message injection: `packages/opencode/src/session/prompt.ts:411-446` (`flushInjectedMessages`)
- Runtime wiring: `packages/opencode/src/session/prompt.ts:1418` (inside `SessionPrompt.prompt`)
- Fork commits: `3005c73d1`, `4cc6ba3b0`
- Upstream issue: [opencode/opencode#16626](https://github.com/opencode/opencode/issues/16626)

## Delivery Authority Ordering

Based on live behavior investigation (session `260927-1114-hard-gate-mechanism`):

| Channel | Authority | Evidence |
|---------|-----------|----------|
| `tool.execute.before` throw | Lowest | Agent treats as failed tool call, continues |
| `tool.execute.after` `output.inject` | Medium | Synthetic user message, same turn |
| `experimental.chat.system.transform` | High | System prompt on every LLM call |
| `session.stopping` `{stop: false}` | Highest | Fresh user turn, agent must respond |
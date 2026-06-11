---
type: memory
title: "System Prompt Modifications Invalidate Anthropic Cache"
createdAt: "2026-06-11T17:55:00+02:00"
updatedAt: "2026-06-11T17:55:00+02:00"
tags: [cache, anthropic, system-prompt, plugin, gotcha]
see_also:
  - "concepts/0002-system-prompt.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: System Prompt Modifications Invalidate Anthropic Cache

## Fact

The `experimental.chat.system.transform` plugin hook (fired at `packages/opencode/src/session/llm/request.ts:69` and `packages/opencode/src/agent/agent.ts:409`) modifies the system prompt array before sending to the LLM. Any modification to the system prompt invalidates Anthropic's prompt cache — the system prompt is at the beginning of the conversation and part of the cache key.

## Context

The agent-persona-coach plugin used this hook to append `<system-reminder>` blocks containing reflection questions. Because the hook fires on every LLM request, and nudges were pending on most requests, the system prompt changed repeatedly — invalidating the Anthropic cache 3-5 times per user message cycle.

## Impact

Every cache invalidation forced Anthropic to reprocess the entire system prompt + conversation from scratch, adding seconds of latency. The fix (agent-persona-coach ADR-0004) removed the system transform usage entirely, switching to message injection which preserves the cache prefix.

**General rule for plugins:** Avoid modifying the system prompt via `experimental.chat.system.transform` if the provider supports prompt caching. Use `output.inject` via `tool.execute.after` instead — it appends content after the cache breakpoint, preserving the cached prefix.

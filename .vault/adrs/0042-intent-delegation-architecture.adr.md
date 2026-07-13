---
type: adr
id: ADR-0042
title: "Intent Delegation Architecture"
createdAt: "2026-07-11T17:55:00Z"
updatedAt: "2026-07-12T18:45:00Z"
status: accepted
tags: [tool-calling, split-model, intent-delegation, architecture]
see_also:
  - "[[0005-agent-meta-tool-plugin.concept.md]]"
  - "[[0008-agent-model-selection.concept.md]]"
---

# Intent Delegation Architecture

## Context

Qwen3.6-27b performs poorly at tool calling — confusing tool names and parameter signatures. The user requires:

> "Main model tries to call tools as best it can, but this will be passed to smaller model to actually compose function call and it will be executed by better-opencode. Main model will think it does well, but small model underneath will ensure it has right signature."

## Decision

**Intent delegation model:**
- Main model generates tool call intent (attempts its best)
- Split router intercepts intent and delegates to small model
- Small model composes correct function call signature
- Composed signature is executed

```
main_model → meta_use({name, args})
    ↓
    split_router.delegate(intent={name, args}, schema)
    ↓
    small_model.compose(intent, schema) → {composedArgs: {...}}
    ↓
    tool.execute(composed_args)
    ↓
    result
```

## Alternatives Considered

1. **Standalone MCP server** — rejected (duplicates agent-meta-tool infrastructure)
2. **Full streamText split** — *deferred to Phase 2* (requires core changes, test Phase 1 first)
3. **Simple validation layer** — rejected (doesn't solve the problem, just catches errors)

## Consequences

**Positive:**
- Main model behavior unchanged
- Small model ensures correct signatures
- Minimal core changes to opencode (LLM service interface + plugin LLM access)
- Fully reversible via config

**Negative:**
- +100-200ms latency per tool call
- Dependency on small model availability
- Must handle composition failures gracefully

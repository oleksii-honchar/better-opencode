---
type: adr
id: ADR-0048
title: "Manage System Tools Through Meta Tool"
createdAt: "2026-07-11T17:55:00Z"
updatedAt: "2026-07-12T18:45:00Z"
status: accepted
tags: [tool-calling, split-model, system-tools, meta-tool]
see_also:
  - "[[0042-intent-delegation-architecture.adr.md]]"
  - "[[0046-two-phase-implementation-strategy.adr.md]]"
---

# Manage System Tools Through Meta Tool

## Context

Need to apply split router composition to system tools (edit, write, read, bash) in addition to meta tools.

## Decision

**Enable system tools to be managed by the meta tool system through opencode configuration:**

1. Add `manage_system_tools: true` configuration option to meta tool
2. Create wrapper tools that intercept system tool calls
3. Apply same composition logic as meta tools
4. Execute original tool with composed arguments

**Configuration:**
```jsonc
{
  "agent-meta-tool": {
    "split_router": {
      "enabled": true,
      "model_name": "mammoth/qwen3.5-0.8b",
      "manage_system_tools": true
    }
  }
}
```

## Alternatives Considered

1. **Separate wrapper implementation** — rejected (duplicates logic)
2. **Only manage meta tools** — rejected (system tools also fail often)
3. **Modify opencode directly** — rejected (deferrable to Phase 2)

## Consequences

**Positive:**
- Unified management of all tools
- Same composition logic applies to system tools
- No separate implementation needed
- Configurable on/off per tool

**Negative:**
- All system tool calls go through meta tool
- May add slight latency overhead
- Requires opencode hook support for system tools

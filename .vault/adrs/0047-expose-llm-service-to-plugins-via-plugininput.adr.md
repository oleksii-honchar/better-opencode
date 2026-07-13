---
type: adr
id: ADR-0047
title: "Expose LLM Service to Plugins via PluginInput"
createdAt: "2026-07-11T17:55:00Z"
updatedAt: "2026-07-12T18:45:00Z"
status: accepted
tags: [tool-calling, split-model, plugin, llm-service, plugininput]
see_also:
  - "[[0042-intent-delegation-architecture.adr.md]]"
  - "[[0005-agent-meta-tool-plugin.concept.md]]"
  - "[[0046-two-phase-implementation-strategy.adr.md]]"
---

# Expose LLM Service to Plugins via PluginInput

## Context

Initially planned to call small model directly via llama.cpp HTTP API for lower latency. However:
- External dependencies on llama.cpp endpoints
- Separate configuration management
- Bypasses opencode's unified error handling
- Increases maintenance burden

The plugin system currently has NO LLM access — `PluginInput` only provides an SDK client (HTTP API), project/directory info, and workspace adapters.

## Decision

**Expose opencode's internal LLM service to plugins by adding `llm: PluginLLMService` to `PluginInput`:**

1. Add `PluginLLMService` interface to `@opencode-ai/plugin` with `chatCompletionWithModel()`
2. Add `llm` field to `PluginInput` type
3. Wire in plugin layer: acquire `LLM.Service`, create wrapper, pass into `PluginInput`
4. The split router calls `pluginInput.llm.chatCompletionWithModel()` — goes through opencode's provider system

**Flow:** Split Router → `PluginInput.llm.chatCompletionWithModel()` → `LLM.Service.stream()` → Provider resolution → llama.cpp → composed args

## Alternatives Considered

1. **Direct HTTP to llama.cpp** — rejected (bypasses opencode, adds external dependency)
2. **Standalone MCP server** — rejected (duplicates infrastructure)
3. **SDK client (HTTP to opencode's own server)** — rejected (same as direct HTTP, circular dependency)

## Consequences

**Positive:**
- Standardized integration through opencode plugin system
- Model resolution handled by opencode provider system
- Unified error handling and metrics
- No external HTTP dependencies
- Easier to maintain and configure

**Negative:**
- Slightly higher latency (opencode framework overhead)
- Requires opencode core change: `PluginInput` modification + plugin layer wiring
- Plugin must receive `PluginInput` reference (not just hooks)

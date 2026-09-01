---
type: index
title: "Domain Concepts"
createdAt: "2026-06-08T18:32:00Z"
updatedAt: "2026-09-01T15:56:13Z"
tags: []
---

# Domain Concepts

Mental models, domain vocabulary, and architectural patterns used in better-opencode.

## Nodes

- [[0001-session-model.concept.md]] — Session model: parent-child hierarchy, sub-agent task delegation
- [[0002-system-prompt.concept.md]] — System prompt composition: 5-layer runtime assembly (provider → agent → instructions → skills → env)
- [[0003-llm-turn-management.concept.md]] — LLM turn management: main loop, multi-step tool execution, provider-executed vs app-executed tools, compaction
- [[0004-subagent-delegation.concept.md]] — Subagent delegation via Task(): blocking call via Effect fiber, child session creation, subagent permissions, background mode, Runner state machine, continuation flow, no parent-child signaling
- [[0005-agent-meta-tool-plugin.concept.md]] — Agent Meta Tool Plugin: dynamic skill/tool management via system prompt and tool definition interception
- [[0006-opencode-observability.concept.md]] — OpenCode Observability (OTEL): telemetry pipeline, data sources, Grafana dashboards
- [[0007-unstuck-loop-detection.concept.md]] — Unstuck Loop Detection System: fingerprint-based detection, evidence accumulation, nudge-and-prune, per-stream lifecycle (ADR-0072), self-diagnosis threshold 2 (ADR-0073), 7 detection types (xml_repetition with partial/prefix tag detection, doom_loop via Allow-then-Catch, model-specific thresholds)
- [[0008-agent-model-selection.concept.md]] — Agent Model Selection from Frontmatter: three fields (models, model, modelPreset), two-stage match (exact (providerID, modelID) mirroring, ADR-0097, then provider-only), provider-model format
- [[0009-agent-model-variant-parsing.concept.md]] — Agent Model Variant Parsing (`:variant` Syntax): inline variant extraction, precedence rules, single/multi-model propagation
- [[0010-dynamic-context-injection.concept.md]] — Dynamic Context Injection with KV Cache Preservation: two-phase pattern (synthetic messages before compaction, system prompt after)
- [[0011-dynamic-skill-visibility.concept.md]] — Dynamic Skill Visibility Chain (Registered but Invisible): process-wide registration vs per-session injection, plugin search blind spot, KV-cache-driven visibility gap
- [[0012-mcp-oauth-auth-flow.concept.md]] — MCP OAuth Auth Flow: SDK auth chain, guardedFetchFn transport boundary, oauthServers type-remote-only limitation
- [[0013-in-flight-model-switching.concept.md]] — In-flight Model Switching: agent-driven mid-turn model switching via a `switch_model` tool riding the runLoop per-iteration model re-resolution

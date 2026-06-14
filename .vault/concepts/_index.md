---
type: index
title: "Domain Concepts"
createdAt: "2026-06-08T18:32:00Z"
updatedAt: "2026-06-14T13:10:00Z"
tags: []
---

# Domain Concepts

Mental models, domain vocabulary, and architectural patterns used in better-opencode.

## Nodes

- [[0001-session-model.concept.md]] — Session model: parent-child hierarchy, sub-agent task delegation
- [[0002-system-prompt.concept.md]] — System prompt composition: 5-layer runtime assembly (provider → agent → instructions → skills → env)
- [[0003-llm-turn-management.concept.md]] — LLM turn management: main loop, multi-step tool execution, provider-executed vs app-executed tools, compaction
- [[0004-subagent-delegation.concept.md]] — Subagent delegation via Task(): blocking call via Effect fiber, child session creation, subagent permissions, background mode
- [[0005-agent-meta-tool-plugin.concept.md]] — Agent Meta Tool Plugin: dynamic skill/tool management via system prompt and tool definition interception
- [[0006-opencode-observability.concept.md]] — OpenCode Observability (OTEL): telemetry pipeline, data sources, Grafana dashboards

---
type: architecture
title: "better-opencode — System Context"
c4_level: system_context
system: better-opencode
createdAt: "2026-06-08T18:45:00Z"
updatedAt: "2026-06-08T18:45:00Z"
tags: [system-context]
see_also: []
linked_elements: []
---

# Architecture: better-opencode — System Context

## Diagram

_(System context diagram to be added during guided onboarding)_

## Elements

| ID | Name | Type | Description |
|----|------|------|-------------|
| `better-opencode` | better-opencode | System | AI code assistant — agent framework with session management, tool execution, and sub-agent delegation |

## Notes

better-opencode is a TypeScript/Effect-based monorepo. Primary subsystems: session management (SQLite-backed conversation storage), provider integration (LLM abstraction), tool execution framework, and agent orchestration (parent-child subtask spawning).

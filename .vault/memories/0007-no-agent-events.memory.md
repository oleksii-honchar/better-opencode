---
type: memory
title: "No Agent-to-Agent Communication Events on the Bus"
createdAt: "2026-07-25T13:50:00Z"
updatedAt: "2026-07-25T13:50:00Z"
tags: [agent, communication, bus, gotcha]
see_also:
  - "concepts/0004-subagent-delegation.concept.md"
---

# Memory: No Agent-to-Agent Communication Events on the Bus

## Fact

The opencode PubSub bus (`packages/opencode/src/bus/index.ts`) has **no agent-specific events**. There are no `AgentEvent.*` events, no agent-to-agent notifications, no agent state changes, and no agent completion events.

## Context

While investigating the sub-agent completion and parent continuation flow, we discovered that the bus event system only handles: session-level events (status, diff, error, compaction), file events, permission events, LSP diagnostics, MCP tool changes, and TUI events. There is no mechanism for agents to communicate directly — handoff is managed through shared session state (`session.md` frontmatter `nextAgent` field), not events.

The available bus events relevant to sessions are:
- `Session.Event.Diff` — File changes
- `Session.Event.Error` — Session errors
- `Session.Event.Compacted` — Session compaction
- `Session.Event.Status` — Status changes (idle/busy/retry)
- `Session.Event.Idle` — Session becomes idle (deprecated)

None of these carry agent-level semantics.

## Impact

Any attempt to build agent-to-agent signaling (e.g., a "queue-aware handoff" where agents check if messages are pending before handing off) would require adding new agent events to the bus, creating an agent subscription mechanism, and routing events to parent agents. This is significant work — not a simple addition.

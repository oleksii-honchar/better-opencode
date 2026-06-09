---
type: concept
title: "Subagent Delegation via Task()"
createdAt: "2026-06-09T09:30:00Z"
updatedAt: "2026-06-09T09:30:00Z"
tags: [llm, subagent, delegation, task-tool]
see_also:
  - "concepts/0001-session-model.concept.md"
  - "concepts/0003-llm-turn-management.concept.md"
---

# Concept: Subagent Delegation via Task()

## What

The Task() tool is the mechanism by which an agent delegates work to a specialized subagent. It creates a child session, runs the subagent's own LLM loop synchronously (blocking the parent's Effect fiber), and injects the result back into the parent's LLM stream. The subagent has its own agent type, permission rules, and isolated conversation context.

## Why

Subagent delegation enables task decomposition: a main agent can offload research, code exploration, or background work to specialized agents without losing context. The blocking model ensures the parent agent has complete results before continuing, while the background mode enables parallelism.

## Architecture

### Task() as a Blocking Call

When the LLM calls `Task()`, the flow is:

```
Parent LLM stream (ONE API call)
  ├─ LLM generates text
  ├─ LLM emits "tool-call" → Task(subagent_type, prompt)
  ├─ SDK calls TaskTool.execute() — BLOCKS here
  │   ├─ Create child session (sessions.create)
  │   ├─ Call ops.prompt() → enters subagent's while(true) loop
  │   │   ├─ Subagent makes LLM calls, tool calls
  │   │   └─ Subagent finishes
  │   └─ Return subagent result to SDK
  ├─ SDK emits "tool-result" with subagent output
  └─ LLM continues generating (sees the result)
```

Key: The `yield* runTask()` at `task.ts:352` blocks the Effect fiber. The parent's LLM stream is paused while the subagent runs entirely.

### Blocking vs Background Mode

| Mode | Behavior | Key difference |
|------|----------|----------------|
| **Blocking** (default) | `yield* runTask()` — waits for subagent to finish | Parent loop blocked; result injected into parent's LLM stream |
| **Background** | `background.start()` — launches async, returns immediately | Parent loop continues; result injected later via `task_status` polling |

Background mode requires `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`.

### Subagent Session Creation

From `task.ts:166-186`:

1. Child session created with `parentID: ctx.sessionID`
2. Subagent type resolved from `params.subagent_type` (explore, general, scout, etc.)
3. Permission rules derived from parent session + subagent agent config
4. Model resolved from subagent's config or inherited from parent

### Subagent Permission Rules

Subagents have restricted permissions by default (`agent/subagent-permissions.ts:14-31`):

- `todowrite` and `task` are denied unless explicitly allowed
- Parent session permissions are merged with subagent's agent permissions
- `deriveSubagentSessionPermission()` applies the restriction rules

### Subtask Part Path

An alternative to the Task() tool is the `MessageV2.SubtaskPart` path (`prompt.ts:1728-1753`):

- Used for programmatic subtask creation (from commands)
- Creates a subtask part in the assistant message
- `handleSubtask()` delegates to the subagent synchronously
- Result is injected as a tool result in the same way

### Concurrent Subagents

When the LLM emits multiple Task() calls in one response, they can execute concurrently via `Effect.forEach` with `concurrency: "unbounded"`. This is encouraged by the default system prompt: "batch your tool calls together".

## Relevant Code

- `packages/opencode/src/tool/task.ts:107-379` — TaskTool definition and execute handler
- `packages/opencode/src/agent/subagent-permissions.ts:14-31` — Subagent permission derivation
- `packages/opencode/src/session/prompt.ts:1728-1753` — `handleSubtask()` — programmatic subtask path
- `packages/opencode/src/session/prompt.ts:450-530` — Subtask execution and result injection
- `packages/opencode/src/session/run-state.ts:87-108` — `ensureRunning()` — session run state management

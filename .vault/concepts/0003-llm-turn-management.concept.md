---
type: concept
title: "LLM Turn Management"
createdAt: "2026-06-09T09:30:00Z"
updatedAt: "2026-06-09T09:30:00Z"
tags: [llm, turn, tool-execution, architecture]
see_also:
  - "concepts/0001-session-model.concept.md"
  - "concepts/0002-system-prompt.concept.md"
  - "concepts/0004-subagent-delegation.concept.md"
---

# Concept: LLM Turn Management

## What

The LLM turn management in opencode orchestrates how the agent processes user prompts, makes tool calls, reasons, and iterates — all governed by a `while(true)` loop that wraps a single LLM streaming call per iteration. The key insight is that **the LLM SDK handles multi-step tool execution internally within one stream**, meaning a single API call can include reasoning, tool calls, tool results, and continued generation without the app restarting the loop.

## Why

Understanding turn management is essential for debugging agent behavior, implementing plugins (especially the `session.stopping` hook), and reasoning about how compaction, context windows, and tool execution interact. It explains why some tool calls appear "instant" (provider-executed) while others require loop restarts (app-executed).

## Architecture

### The Main Loop

Entry point: `packages/opencode/src/session/prompt.ts:1337-1635` — `runLoop(sessionID)`:

```
while(true) {
  1. Fetch messages (filterCompactedEffect)
  2. Check exit conditions → break if LLM finished with no pending tools
  3. Resolve tools for current agent
  4. Create assistant message
  5. Call LLM via processor.process() → streams events
  6. Handle result ("compact" | "stop" | "continue")
  7. If compaction needed → create compaction task, continue
  8. If subtask → handleSubtask(), continue
  9. Loop back to step 1
}
```

### LLM SDK Multi-Step Tool Execution (Within One Stream)

The LLM SDK (native runtime via `@opencode-ai/llm` or AI SDK adapter) supports **multi-step tool execution within a single stream**:

```
LLM stream starts (ONE API call)
  ├─ LLM generates reasoning/text
  ├─ LLM emits "tool-call" event
  ├─ SDK calls tool's execute() handler INTERNALLY
  ├─ SDK emits "tool-result" event back into stream
  ├─ LLM continues generating (sees the tool result)
  ├─ LLM emits another "tool-call" event
  ├─ SDK calls execute(), emits "tool-result"
  └─ ... repeats until LLM finishes without tool calls
  └─ LLM emits "finish" event
```

Key files:
- `packages/opencode/src/session/llm/native-runtime.ts:131-148` — `nativeTool` wraps tool `execute` handlers
- `packages/opencode/src/session/processor.ts:305-689` — `handleEvent` processes stream events

### Two Modes of Tool Execution

| Mode | How it works | Loop behavior |
|------|-------------|---------------|
| **Provider-executed** | LLM SDK calls tool's `execute()` internally, feeds result back to LLM | `providerExecuted: true` on tool part → no loop restart |
| **App-executed** | LLM SDK emits tool-call event, stops with `finish: "tool-calls"` | App executes the tool, appends result, loop continues |

The distinction is tracked via the `providerExecuted` metadata flag on tool parts. The loop exit condition checks for unexecuted tool calls at `prompt.ts:1353-1356`:

```typescript
const hasToolCalls = lastAssistantMsg?.parts.some(
  (part) => part.type === "tool" && !part.metadata?.providerExecuted
)
```

### Loop Exit Conditions

The loop exits when ALL are true (`prompt.ts:1358-1420`):

1. `lastAssistant.finish` exists (LLM signaled completion)
2. `finish` is NOT `"tool-calls"` (no pending tool calls)
3. No unexecuted tool calls (`hasToolCalls === false`)
4. `lastUser.id < lastAssistant.id` (assistant replied to this user message)

### Override: `session.stopping` Hook

Before exiting, the loop triggers the `session.stopping` plugin hook (`prompt.ts:1376-1416`). If a plugin returns `{ stop: false, message: "..." }`:

- The injected message is added as a system message
- The loop continues (up to `maxStoppingContinuations = 3` times)
- This is the **only** way to override the LLM's "I'm done" decision

### Compaction and Overflow

Token tracking happens per-step. When `isOverflow()` returns true (`overflow.ts:8-32`):

1. `ctx.needsCompaction = true` → processor returns `"compact"`
2. A compaction task is created → the "compaction" agent summarizes older messages
3. The loop continues with the summary injected

Key constants:
- `COMPACTION_BUFFER = 20_000` — reserved output tokens before compaction triggers
- `tail_turns = 2` — most recent turns preserved intact

### Doom Loop Protection

If the same tool is called 3 times with identical input (`DOOM_LOOP_THRESHOLD = 3`), the permission system intervenes (`processor.ts:424-449`):

- The agent is prompted with a "doom_loop" permission request
- The user must explicitly approve continuing

## Relevant Code

- `packages/opencode/src/session/prompt.ts:1337-1635` — `runLoop()` — main turn loop
- `packages/opencode/src/session/processor.ts:305-689` — `handleEvent()` — stream event processing
- `packages/opencode/src/session/processor.ts:780-848` — `process()` — LLM stream orchestration
- `packages/opencode/src/session/llm/native-runtime.ts:131-148` — `nativeTool()` — tool handler binding
- `packages/opencode/src/session/overflow.ts:8-32` — `isOverflow()` — compaction trigger
- `packages/opencode/src/session/compaction.ts:1-646` — compaction logic
- `packages/opencode/src/tool/task.ts:107-379` — Task() tool (subagent delegation)

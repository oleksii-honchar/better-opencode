---
type: memory
title: "Post-Compaction Recall Race Condition — Async Fork Causes API Error"
id: MEM-0025
category: bug-pattern
createdAt: "2026-09-16"
updatedAt: "2026-09-16"
tags: [compaction, recall, race-condition, plugin, bensyne]
system: opencode
see_also:
  - [[0107-sequential-post-compaction-recall.adr.md]]
  - [[0023-fix-post-compaction-recall-race-condition.spec.md]]
---

## Fact

The post-compaction recall hook (`experimental.compaction.post_recall`) was forked asynchronously via `Effect.forkDetach`, causing a race condition where the recall prompt was sent before the compaction summary was written to the conversation history. This resulted in the OpenAI API error: "Cannot have 2 or more assistant messages at the end of the list."

## Context

The Bensyne recall plugin sends a synthetic user message via `session.prompt()` to remind the agent to recall its traversal history after compaction. The hook was forked asynchronously in `packages/opencode/src/session/compaction.ts`, meaning the recall prompt was queued on the server and processed after the compaction summary (an assistant message) was written to the conversation history. When the server tried to process the recall prompt, the conversation ended with two consecutive assistant messages, triggering the API error.

The race condition also caused multiple recall prompts to be sent in rapid succession (5 times observed in production logs at 2026-09-16T07:15:17), further confusing the conversation flow. The session exited immediately after the API error, without ever processing the recall prompt — the agent never got a chance to recall its traversal history from Bensyne.

## Impact

The agent wasted context figuring out what to do next instead of resuming productively after compaction. The session exited after only 2 steps, with no valuable outcome.

## Resolution

Replace `Effect.forkDetach` with direct synchronous invocation for `postCompactionRecall` in `compaction.ts`. Keep `postCompactionRestore` forked (unchanged) — it's independent of the recall sequence. Additionally, add self-reflect decision tree branches to all 15 agents to ensure they recall their traversal history after compaction (defense-in-depth).

See [[0107-sequential-post-compaction-recall.adr.md]] and [[0023-fix-post-compaction-recall-race-condition.spec.md]] for details.

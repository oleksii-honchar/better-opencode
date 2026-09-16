---
type: decision
title: "Sequential Post-Compaction Recall — Synchronous Hook Invocation"
id: DEC-0107
status: accepted
createdAt: "2026-09-16"
updatedAt: "2026-09-16"
tags: [compaction, recall, plugin, race-condition, bensyne]
system: opencode
see_also:
  - [[0056-core-pipeline-injection.adr.md]]
  - [[0057-two-phase-context-injection.adr.md]]
---

## Context

The post-compaction recall hook (`experimental.compaction.post_recall`) was triggered via `Effect.forkDetach` (asynchronous fire-and-forget) in `packages/opencode/src/session/compaction.ts`. This caused a race condition where the recall prompt was sent before the compaction summary was written to the conversation history. The OpenAI API error "Cannot have 2 or more assistant messages at the end of the list" occurred when the session tried to respond to the recall prompt while the compaction summary assistant message was still in the conversation.

The Bensyne recall plugin sends a synthetic user message via `session.prompt()` to remind the agent to recall its traversal history after compaction. However, the asynchronous fork meant the recall prompt was queued on the server, processed after the compaction summary was written, and the agent never successfully recalled.

The race condition also caused multiple recall prompts to be sent in rapid succession (5 times observed in production logs), further confusing the conversation flow.

## Decision

Replace `Effect.forkDetach` with direct synchronous invocation for `postCompactionRecall` in `compaction.ts`:

**Before:**
```typescript
yield* (postCompactionRecall(input.sessionID, plugin, userMessage).pipe(
  Effect.forkDetach,
) as unknown as Effect.Effect<void, never, never>)
```

**After:**
```typescript
yield* postCompactionRecall(input.sessionID, plugin, userMessage)
```

Keep `postCompactionRestore` forked (unchanged) — it's independent of the recall sequence and doesn't participate in conversation message ordering.

## Alternatives Considered

1. **Include recall prompt in compaction response:** Embed recall prompt in the compaction assistant message. Pros: no race condition, more efficient. Cons: changes compaction response format, more invasive.
2. **Add delay before sending recall prompt:** Pros: simple. Cons: race condition may still occur under heavy load; delay is arbitrary.
3. **Send recall as part of next user message:** Pros: no race condition. Cons: recall only happens when user sends a message, not automatically after compaction.

## Consequences

- **Correctness:** The recall prompt is now sent after the compaction summary is written, ensuring correct message ordering. The agent can successfully recall its traversal history after compaction.
- **Latency:** Slightly increased compaction latency (adds one HTTP round-trip for the recall call). Acceptable for correctness.
- **Plugin changes:** None required. The Bensyne plugin code (`plugin/bensyne/index.ts`) remains unchanged.
- **Self-reflect decision tree branches:** Added to all 15 agent decision trees to ensure agents recall their traversal history after compaction, providing defense-in-depth against future race conditions.

## Verification

The fix was verified by running the targeted compaction test (`bun test packages/opencode/src/session/compaction.test.ts`) and manual verification of the post-compaction recall behavior.

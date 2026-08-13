---
type: memory
title: "pruneLoopingMessages Creates Orphaned Tool-Results"
createdAt: "2026-08-13T18:00:00Z"
updatedAt: "2026-08-13T18:00:00Z"
tags: [tool-calls, orphan, prune, unstuck, root-cause, codex, deepseek]
see_also:
  - "adrs/0078-fix-prune-preserve-pairs.adr.md"
  - "specifications/0017-fix-prune-looping-messages.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: pruneLoopingMessages Creates Orphaned Tool-Results

## Fact

The `pruneLoopingMessages` function in `packages/opencode/src/plugin/unstuck/wrapper.ts` is the root cause of the codex "No tool call found for function call output" error and the DeepSeek "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'" error.

## Context

The function was introduced in commit `5d0a703cc5` ("fix") on branch `fix/20812-1926-unstuck` as part of the nudge-and-prune loop detection strategy. It removes the last N assistant messages by index without considering tool-call/tool-result pair integrity. When an assistant message containing a tool-call part is pruned, the corresponding tool-result part in a subsequent tool message becomes orphaned.

This was discovered through a second researcher investigation that corrected the earlier hypothesis (the bug was not in `MessageV2.toModelMessagesEffect` as assumed in ADR-0075, but in the prune function itself).

## Impact

- Affects all providers: OpenAI Responses (Codex), Chat Completions (DeepSeek via LiteLLM), and any provider that pairs tool-calls with tool-results.
- The error manifests as provider rejections during LLM request processing.
- The repair layer at `message-v2.ts` (ADR-0076/0077) catches the orphans downstream but does not fix the source.

## Key Details

- **File:** `packages/opencode/src/plugin/unstuck/wrapper.ts`
- **Function:** `pruneLoopingMessages()` (lines 50-66)
- **Invocation:** Line 415 (nudge-and-prune loop detection)
- **Tool-call/result linking:** AI SDK `toolCallId` — each tool-result must have a matching tool-call with the same ID in the message history.
- **Fix:** ADR-0078, spec 0017 — modify pruneLoopingMessages to collect and prune matching tool-call IDs.

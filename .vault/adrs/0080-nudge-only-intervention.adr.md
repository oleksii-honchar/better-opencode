---
type: adr
id: ADR-0080
title: "Remove Message Pruning from Unstuck Nudge Path — Nudge-Only Intervention"
status: accepted
createdAt: "2026-08-14T13:00:00Z"
updatedAt: "2026-08-14T13:00:00Z"
tags: [unstuck, nudge, prune, loop-detection, tool-calls, context-integrity]
supersedes: ["ADR-0078"]
superseded_by: []
see_also:
  - "adrs/0078-fix-prune-preserve-pairs.adr.md"
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "memories/0018-unstuck-trim-bug-root-cause.memory.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0080: Remove Message Pruning from Unstuck Nudge Path — Nudge-Only Intervention

## Context

The unstuck plugin in `better-opencode` uses a "nudge-and-prune" strategy when a stuck pattern is detected. The `pruneLoopingMessages` function in `packages/opencode/src/plugin/unstuck/wrapper.ts` removes the last N assistant messages and their associated tool-result messages from the prompt before resending with a nudge.

This causes two problems:
1. **Context length fluctuation** — the prompt sent to the LLM changes size between attempts (messages removed → prompt shrinks)
2. **Agent being lost** — removing assistant tool-call messages and tool-result messages deletes the model's working history of what tools did

Commit `04c1e08c78` extended pruning to also remove tool-result messages (not just assistant messages), making the problem worse. The user requirement is explicit: never manipulate the context sent to the LLM; only append a nudge.

ADR-0078 attempted to fix the orphan issue by making `pruneLoopingMessages` preserve tool-call/tool-result pairs. But the fundamental approach of pruning messages is itself the problem.

## Decision

Remove `pruneLoopingMessages` entirely. The nudge path resends `[...originalPrompt, nudgeMessage]` — the prompt is byte-identical to the failing attempt plus the nudge message.

Consequently:
- **Strategy rename:** `"nudge-and-prune"` → `"nudge"` (default). The old literal `"nudge-and-prune"` remains accepted as a backward-compatible alias with identical behavior (no pruning).
- **Config cleanup:** `pruneCount` is removed from `UnstuckConfig`, `defaultConfig`, and the Effect schema. Existing configs with `pruneCount` silently ignore the key (Effect Schema drops unknown keys by default).
- **ADR-0078 superseded:** Its repair layer in `message-v2.ts` remains as defense-in-depth, but the trigger (the `pruneLoopingMessages` function) no longer exists.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|--------------|
| Nudge-only (no pruning) | Satisfies the explicit requirement; eliminates the entire class of prune-related bugs; simpler code | Slightly higher token cost per restart vs pruned path | — |
| Keep pruning but only for non-tool messages | Retains the "context shrinking" benefit | Violates the requirement; tool calls/results are the primary stuck-loop content, so this retains the failure mode | Violates user requirement |
| Keep pruning, fix tool-result handling | Pre-04c1e08c78 behavior (ADR-0078) | Already failed in practice; still violates the requirement | Failed in practice; violates requirement |
| Rename strategy but keep pruning | Zero code change; cosmetic only | The name would lie about behavior; doesn't fix the underlying problem | Doesn't address the problem |

## Consequences

- **Positive:** Prompts stay constant-length across nudge restarts (plus the nudge message). The "did pruning remove the wrong message?" edge-case family is eliminated entirely.
- **Positive:** No more orphaned tool-result messages — the repair layer at `message-v2.ts` becomes a general defense-in-depth safety net.
- **Negative:** Slightly higher token cost per nudge restart compared to the pruned path (the prompt is not shrunk). Acceptable per the original requirement.
- **Neutral:** `wrapper.test.ts` prune assertions and `describe("pruneLoopingMessages")` are removed. The strategy check in `wrapper.ts` only special-cases `"warn"`/`"abort"` — both `"nudge"` and `"nudge-and-prune"` fall through to the same nudge-only path, requiring zero extra runtime logic.
- **Neutral:** ADR-0078 is superseded. Its repair layer remains in place as general defense-in-depth for other potential sources of orphaned tool-results.

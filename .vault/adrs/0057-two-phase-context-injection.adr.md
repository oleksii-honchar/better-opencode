---
type: adr
id: ADR-0057
title: "Two-Phase Context Injection: Synthetic Messages Before Compaction, System Prompt After"
status: accepted
createdAt: "2026-07-18T14:10:00Z"
updatedAt: "2026-07-27T18:00:00Z"
tags: [kv-cache, compaction, system-prompt, pattern]
supersedes: []
superseded_by: []
see_also:
  - "concepts/0010-dynamic-context-injection.concept.md"
  - "concepts/0002-system-prompt.concept.md"
  - "adrs/0055-dynamic-skill-registration.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0057: Two-Phase Context Injection: Synthetic Messages Before Compaction, System Prompt After

## Context

After discovering runtime information (e.g., dynamic skills), how should it become visible to the model? Two phases exist:
1. **Before compaction:** Full context window available, synthetic messages survive
2. **After compaction:** Context reduced, need persistent storage

The system prompt must remain stable during the pre-compaction phase to preserve KV cache — changing it would invalidate cached prefixes and force full context reprocessing.

## Decision

Use a two-phase approach:
1. **Before compaction:** Inject discovered information as synthetic user messages via `flushInjectedMessages`. System prompt is untouched — discovered items are NOT added to it.
2. **After compaction:** Restore discovered information to system prompt from session state. AgentMetaTool processes it via `system-transform` into metaState.

This ensures immediate visibility (via synthetic messages) AND persistence after compaction (via system prompt).

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Add to system prompt immediately on discovery | Immediately persistent | Corrupts system prompt baseline; breaks KV cache consistency | Reject: performance |
| System prompt only | Simple | One-turn delay; not visible until next LLM request | Reject: UX |
| Synthetic messages only | Immediate visibility | Lost after compaction; no persistence | Reject: reliability |

## Consequences

- **Positive:** immediate visibility before compaction via synthetic messages
- **Positive:** system prompt remains untouched during discovery (stable baseline, KV cache preserved)
- **Positive:** chat history consistency improves KV cache hit ratio
- **Positive:** persistence after compaction via system prompt
- **Positive:** this is a reusable pattern applicable to any runtime context injection (not just skills)
- **Negative:** two code paths to maintain (synthetic injection + post-compaction restoration)

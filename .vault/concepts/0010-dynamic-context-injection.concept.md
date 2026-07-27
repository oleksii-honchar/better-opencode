---
type: concept
title: "Dynamic Context Injection with KV Cache Preservation"
createdAt: "2026-07-18T14:10:00Z"
updatedAt: "2026-07-27T18:00:00Z"
tags: [kv-cache, system-prompt, compaction, pattern]
see_also:
  - "adrs/0055-dynamic-skill-registration.adr.md"
  - "adrs/0057-two-phase-context-injection.adr.md"
  - "concepts/0002-system-prompt.concept.md"
  - "concepts/0003-llm-turn-management.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Concept: Dynamic Context Injection with KV Cache Preservation

## What

A pattern for injecting runtime-discovered information (e.g., skills, tools, instructions) into the model's context without invalidating KV cache. Uses two phases:

1. **Pre-compaction:** Inject as synthetic user messages via `flushInjectedMessages` — visible immediately in conversation context, system prompt unchanged (KV cache preserved).
2. **Post-compaction:** Promote to system prompt — persistent across compaction, searchable via meta tools.

## Why

The system prompt is a stable baseline rebuilt each turn. If it changes dynamically (e.g., adding discovered skills), the KV cache is invalidated — the model must reprocess the entire context (all prior tokens). For a 60k-token conversation, adding 3k tokens via system prompt change means reprocessing all 63k tokens each turn.

This pattern allows late context injection while:
- Preserving KV cache during normal operation (pre-compaction: stable system prompt)
- Ensuring persistence after compaction (synthetic messages may be compacted away)
- Providing immediate visibility (no one-turn delay)

## Key Details

- **Pre-compaction visibility** relies on synthetic messages staying in conversation history. The model sees them in the same turn via context, but they are NOT part of the system prompt.
- **Post-compaction promotion** is "free" — compaction already forces context rebuild and invalidates KV cache, so changing the system prompt at that point has no additional cost.
- **Deduplication** is critical: discovered items must not duplicate existing system prompt content. Track registered items in session metadata.
- **Non-blocking execution:** Discovery/injection must never block message processing for long. Originally forked; changed to synchronous (~10-50ms) when forked execution caused hangs and race conditions.
- **This pattern is feature-agnostic:** While first implemented for dynamic skill discovery, it applies to any runtime context injection (e.g., project-specific instructions, runtime tool discovery).

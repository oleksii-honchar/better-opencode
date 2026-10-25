---
type: memory
title: "Session Title Generation Is One-Shot, Silent-Guarded, Fire-and-Forget — Default Titles Are Never Retried"
id: MEM-0034
category: behavior-pattern
createdAt: "2026-10-25"
updatedAt: "2026-10-25"
tags: [session, title, prompt-loop, small-model, observability, diagnostics]
system: opencode
see_also:
  - [[0003-llm-turn-management.concept.md]]
  - [[0001-session-model.concept.md]]
---

## Fact

Chat titles are renamed from the default `New session - <ISO>` (or `Child session - <ISO>`) exactly once per session, by `SessionPrompt.ensureTitle` (`packages/opencode/src/session/prompt.ts`, ≈L337–397), invoked only at `step === 1` of the first prompt-loop iteration via `yield* title({…}).pipe(Effect.ignore, Effect.forkIn(scope))` (≈L1551). Every failure path is silent: guard-skips (`parentID` present → children are *never* renamed; title already non-default; history does not contain **exactly one** real (non-synthetic) user message — which makes any later turn a permanent skip), an empty/think-only model response after `<think>` stripping (`if (!cleaned) return`), and any LLM error after `retries: 2` (`Effect.orDie`, then discarded by `Effect.ignore`). Only a *failing `setTitle` write* logs "failed to generate title" — guard-skips and model-call defects leave zero trace in `dev.log`.

## Context

Found while diagnosing "most icm-operator session chat titles didn't change to meaningful text" (session `261025-1726-icm-chat-title-debug`, 2026-10-25). Ground truth measured in `~/.local/share/opencode/opencode.db` (note `time_created` is epoch **ms**): only 3/201 sessions carried a default title (1 icm-operator with 1099 messages, 1 simple-session, 1 cleo-dusk-operator); 10/11 primary icm-operator sessions and all 9 of its child sessions were titled — the agent definition is irrelevant, the mechanism is shared. The model used is `agents.get("title")` (built-in hidden agent; no user `title.md`) → `provider.getSmallModel` → session model; with `small_model` configured to a 2B instruct model, empty/reasoning-only outputs are the most plausible silent abort, and note the strip regex only matches `<think>…</think>` — `…`/`<thinking>` outputs are **not** stripped and yield no first line.

## Impact

Default-timestamp titles in the session list look like "the client never names my sessions", are indistinguishable from a product bug, and are unrecoverable after the fact (no retry by design, no log to root-cause per-session). Long-lived primary-agent chats (e.g. ICM operator sessions) keep the stale title visible for days, which skews perception toward "most sessions of agent X".

## Resolution guidance

Diagnose counts from `session.title` per agent first (main vs `parent_id` split) — don't trust perceived frequency. Robust fixes if wanted: retry `ensureTitle` on later steps, add a deterministic fallback title (truncated first user message), broaden think-tag stripping, and log guard exits at debug level instead of `Effect.ignore`.

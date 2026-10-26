---
type: memory
title: "Title Generation Remediation: Cross-Turn Retry, Bounded In-Call Retry, Deterministic Fallback (Branch State — Pending Merge)"
id: MEM-0035
category: behavior-pattern
createdAt: "2026-10-26"
updatedAt: "2026-10-26"
tags: [session, title, prompt-loop, small-model, retry, observability, remediation]
system: opencode
see_also:
  - [[0034-session-title-one-shot-silent-generation.memory.md]]
---

## Fact

As of 2026-10-26, `SessionPrompt.ensureTitle` (`packages/opencode/src/session/prompt.ts`) is remediated **on branch `261026-feat-title-retry`** (off `patched/dev2`; working-tree changes, **uncommitted/unmerged/unbuilt at vault-write time** — mainline behavior remains exactly MEM-0034 until merge + build + restart). The change:

1. **Cross-turn retry** — removed the once-only guard (`history.filter(real).length !== 1` → return). The call site (`if (step === 1)` per prompt turn) always fired every turn; the guard is what made later turns permanent no-ops. The already-titled guard (non-default title → return) keeps every repeat a cheap, LLM-free no-op, so an untitled session retries on each subsequent prompt — and previously-stuck sessions **self-heal on their next user message** after deploy.
2. **Bounded in-call retry** — the LLM call + output-cleaning is wrapped in an `attempt` effect that **fails typed on both transport failure and empty/unusable output**, retried with `Effect.retry({ times: 2, schedule: Schedule.exponential(1000, 2) })`. Per-attempt died defects are surfaced as retryable errors via `Effect.catchCauseIf(!Cause.hasInterruptsOnly, fail(Cause.squash(cause)))` — the `processor.ts` idiom (effect v4 beta does **not** retry defects).
3. **Deterministic fallback** — after retries exhaust, the title falls back to the first non-empty line of the first real user text (subtask prompts when the first message is subtask-only), capped by the existing 97+… rule; only with no extractable text does a default title survive. A raw `New session - <ISO>` can no longer persist through generation failure.
4. **Observability** — every previously-silent exit now logs (`session.prompt` service, `title:` message prefix): debug for "no real user message", warn for title-agent-missing and each failed attempt, error for retries-exhausted with the fallback decision. Root-causing a untitled chat becomes a log grep.

## Context

Recorded from session `26-10-25261025-1726-icm-chat-title-debug`, reopened 2026-10-26 by the user ("i have this effect again - we need retry to ensure session get it's title"). The recurrence matched MEM-0034's predicted population: 5/231 sessions default-titled in `opencode.db`, **+2 new that same day** (`ses_e88e70ed0ffefkm5DMU4gGx2qu` icm-operator, 97 real user msgs; `ses_e8799f4aeffeHmwR7xX6AXqQt7` cleo-dusk-operator, 11) — long-lived primaries whose first-turn attempt failed and could never retry.

Verification (pre-submit): `tsgo` typecheck clean; targeted tests `packages/opencode/test/session/prompt.test.ts` + `retry.test.ts` = 85 pass / 3 fail, byte-identical to a pristine-branch stashed baseline (the 3 are pre-existing provider-fixture failures).

Working-in-this-area traps found this session (effect `4.0.0-beta.83`, repo `patched/dev2`):
- **API drift:** no `Schedule.intersect`, no `Effect.catchAll` in the beta — use `Effect.retry({times, schedule})` and `Effect.catch`. Read the installed `dist/*.d.ts` + `processor.ts` before coding against pinned deps.
- **Formatter trap:** baseline `prompt.ts` does **not** pass `prettier --check` on this config — `prettier --write` reformatted ~40 unrelated hunks. Hand-match house style; verify via typecheck + targeted tests; reconstruct by splicing the edited function into a `git checkout HEAD --` copy if scope balloons.

## Impact

After merge + `build-and-install.sh` + server restart: default-timestamp titles stop being sticky (self-healing for existing stuck sessions; guaranteed fallback for new ones), and future "why no title" questions are answerable from logs. MEM-0034 describes the still-live mainline behavior and remains accurate until deploy; after deploy, treat MEM-0034 as historical for post-deploy builds and this node as current.

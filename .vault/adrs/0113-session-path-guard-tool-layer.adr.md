---
type: decision
id: DEC-0113
title: "Enforce Session-Path Shape at the Tool Layer via In-Fork Plugin"
status: proposed
createdAt: "2026-10-19T14:31:00Z"
updatedAt: "2026-10-19T14:31:00Z"
tags: [plugin, session-paths, path-shape, guard, agent-sessions, observability]
system: opencode
supersedes: []
superseded_by: []
see_also:
  - "../specifications/0025-session-path-guard-flat-date-defense.spec.md"
  - "../memories/0032-subagent-flat-date-path-generation.memory.md"
  - "../memories/0033-display-normalization-flattens-nested-paths.memory.md"
  - "./0106-fix-rules-inject-silent-failure.adr.md"
---

# DEC-0113: Enforce Session-Path Shape at the Tool Layer via In-Fork Plugin

> **Status note:** implemented and review-PASS on branch `fix/session-path-guard` @
> `749db11bb` (base `e545ec0bb`, `patched/dev2`); **unmerged as of 2026-10-19** (re-verified
> directly by vault-keeper). Flip to `accepted` after merge. Governance deviation (review F-4):
> branch naming and `patched/dev2` base differ from docs' illustrative `YYMMDD-feat-NN` /
> `patched/dev` — keep the deviation note in the merge commit; governance doc may be stale.

## Context

Canonical session folders are `~/.agent-sessions/YY/MM/DD/YYMMDD-HHMM-{shortname}`. Flat-date
trees (`26-10-18/…`) kept recurring **after** the 2026-10-18 fix (`guardSessionPathShape()` in
`history.mjs`). Evidence (session `261019-0812-flat-date-path-issue`, findings E1–E4,
hex-verified tool inputs, two independent post-fix reproductions):

1. Subagent workers spontaneously emit the flat form in write/edit tool calls — even when
   handed the correct nested path plus an explicit warning
   ([[0032-subagent-flat-date-path-generation.memory.md]]).
2. The write/edit tools create parent directories verbatim — no shape handling at the tool layer.
3. Result: silent orphan flat trees (split-brain artifacts); the canonical nested session is
   unaffected. The history.mjs guard worked — it just guards the wrong layer (script calls,
   not file writes).

## Decision

Implement `session-path-guard` as a **first-party internal plugin** in the fork
(`packages/opencode/src/plugin/session-path-guard.ts`), registered in `plugin/index.ts`
`INTERNAL_PLUGINS` (+2 lines), hooking `tool.execute.before`:

- **Normalize silently, never block** (session DEC-2): mutate `args.filePath`/`args.path`
  flat→nested in place and log a structured WARN (`service=plugin.session-path-guard`) naming
  both forms + sessionID. Observability per ADR-0106 precedent
  ([[0106-fix-rules-inject-silent-failure.adr.md]]).
- **Match scope** (session DEC-3): only paths anchored at the resolved sessions root
  (`AGENT_SESSIONS_DIR ?? ~/.agent-sessions`, plus literal `~/.agent-sessions` prefix) whose
  **first segment** matches `^\d\d-\d\d-\d\d(/|$)`; tool-id allowlist `{write, edit, read}`.
  Including `read` turns flat-path poisoned context into recovery instead of a miss. Deeper
  flat segments (e.g. `archive/26-10-18`) stay untouched — preserves the archive layout.
- **Duplicated 2-line sessions-root resolver** (session DEC-4) instead of importing
  `session/reminders.ts` (avoids heavy module graph / import cycles); cross-referencing
  comments + shared fixture values contain drift.
- **No calendar validation** (session DEC-5): any `NN-NN-NN` first segment normalizes
  (`99-99-99 → 99/99/99`). The invariant is shape, not calendar truth.
- **Keep the history.mjs guard** (session DEC-6): layered defense; it covers script
  invocations the plugin does not. (Re-verified 2026-10-19: guard still present in shipped
  script — DEC-6 invariant holds.)

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|---|---|---|---|
| Patch `tool/write.ts`/`edit.ts` directly | Direct | Upstream-owned files (rebase tax), logic duplicated per tool | Rejected — plugin covers all guarded tools centrally, zero upstream-file edits |
| Symlink/firmlink `26-10-18 → 26/10/18` | Cheap | Fragile, per-date, blesses the wrong form | Rejected |
| Prompt/skill/delegation hardening only | No code | Demonstrably insufficient — both post-fix reproduces had correct nested paths in context | Rejected (evidence-backed) |
| User-level plugin only (no fork change) | No rebuild | Drifts from shipped binary, invisible to other installs | Dropped at human review 2026-10-19 (OD-2) |
| Throw RED FLAG instead of normalize | Model-visible correction | Costs a tool round-trip; risks retry loops in weak models | Deferred as config-gated option (OD-1), not built |

## Consequences

- **Positive:** flat-date orphan trees stop being created at the point of harm; one hook covers
  parent and subagents; ships with the binary; survives rebases via the established
  internal-plugin pattern; `read` guard recovers already-poisoned contexts.
- **Negative:** agents may briefly believe their flat string persisted (mitigated by WARN naming
  both forms + read-guard recovery); two guard implementations (plugin + history.mjs) must not
  drift (mitigated by cross-reference comments + shared fixtures + tests).
- **Neutral / accepted gaps:** `apply_patch`, raw `bash` writes, MCP file tools unguarded (all
  recorded incidents were write/edit); extension = add tool ids to the Set + tests.

## Maintenance

Periodic audit (also in [[0025-session-path-guard-flat-date-defense.spec.md]] Behaviors):

```bash
find ~/.agent-sessions -maxdepth 1 -type d -name '2[0-9]-[0-9][0-9]-[0-9][0-9]'
```

As of 2026-10-19 (~14:30 UTC) the audit population is **empty** — independently re-run by this
vault-keeper agent (0 flat dirs at root and under `26/`), consistent with the reviewer's
byte-level full-depth scan. No cleanup backlog exists.

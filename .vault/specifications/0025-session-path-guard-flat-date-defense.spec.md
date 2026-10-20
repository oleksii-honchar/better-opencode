---
type: specification
kind: bugfix
status: active
title: "Session-Path Guard — Tool-Layer Defense Against Flat-Date Session Paths"
createdAt: "2026-10-19T14:31:00Z"
updatedAt: "2026-10-20T12:28:00Z"
tags: [session-paths, plugin, path-shape, agent-sessions]
system: opencode
owner: "oleksii"
see_also:
  - "../adrs/0113-session-path-guard-tool-layer.adr.md"
  - "../memories/0032-subagent-flat-date-path-generation.memory.md"
  - "../memories/0033-display-normalization-flattens-nested-paths.memory.md"
---

# Spec: Session-Path Guard (flat-date defense)

> **Status:** IMPLEMENTED — merged into `patched/dev2` (ancestry verified 2026-10-20),
> installed build `fix/session-path-guard-202610191208`.

## Goal

Make flat-date session folders (`~/.agent-sessions/26-10-18/…`) un-creatable by agent tool
calls: normalize any guarded write/edit/read targeting `<sessionsRoot>/NN-NN-NN/…` to the
nested `NN/NN/NN` form, observably, without blocking the agent.

## Phases

- [x] Phase 1 — fork implementation: `plugin/session-path-guard.ts` + co-located test +
  2-line `INTERNAL_PLUGINS` registration (branch `fix/session-path-guard` @ `749db11bb`)
- [x] Phase 2 — live probe: write probe lands nested (hex `2f`), read corrections recover,
  out-of-root untouched, WARN names both forms
- [x] Phase 3 — orphan cleanup: population empty (audit = 0 flat dirs; re-confirmed 2026-10-19)
- [x] Phase 4 — knowledge promotion: this node + DEC-0113 + memories 0032/0033
- [x] Phase 5 — merge `fix/session-path-guard` onto `patched/dev2` (**user decision**);
  flip DEC-0113 to accepted

## Behaviors (test-pinned contract)

1. `<root>/26-10-19/x` → `<root>/26/10/19/x` (rewrite + WARN with `from`/`to`/sessionID + trust-the-bytes note).
2. First segment not matching `^\d\d-\d\d-\d\d(/|$)` → untouched (includes deeper flat segments like `archive/26-10-18`, 4-digit years, already-nested forms).
3. Paths not anchored at the resolved sessions root (or literal `~/.agent-sessions`) → untouched.
4. Only tool ids `{write, edit, read}` are guarded.
5. Shape rule, not calendar: `99-99-99 → 99/99/99`.
6. Audit command for regressions: `find ~/.agent-sessions -maxdepth 1 -type d -name '2[0-9]-[0-9][0-9]-[0-9][0-9]'`.

## Risks

- False rewrites of user data → anchored at resolved sessions root only; tests pin non-root paths.
- Silent redirect confuses agent self-report → WARN names both forms; read-guard recovers.
- Guard drift vs `history.mjs` regex → cross-referenced comments, shared fixtures, tests on both sides.
- Uncovered generators (`apply_patch`, `bash`, MCP file tools) → accepted LOW; allowlist extension path documented.

## Open decisions

- OD-1: config-gated throw-vs-normalize — deferred, not built.
- Rollback: remove the 2 registration lines; one-step, no data migration.

## Links

Decision: [[0113-session-path-guard-tool-layer.adr.md]] · Memories: [[0032-subagent-flat-date-path-generation.memory.md]], [[0033-display-normalization-flattens-nested-paths.memory.md]]

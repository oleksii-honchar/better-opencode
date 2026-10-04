---
type: specification
kind: feature
status: active
title: "Runaway-Loop Hardening & Telemetry Integrity (2026-10-03 incident)"
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [incident, compaction, doom-loop, telemetry, 2026-10-03]
system: opencode
owner: "oleksii"
see_also:
  - "../adrs/0108-per-key-cross-stream-detector-state.adr.md"
  - "../adrs/0109-capped-post-compaction-re-anchor.adr.md"
  - "../adrs/0110-autocontinue-consecutive-cap.adr.md"
  - "../adrs/0111-compaction-goal-integrity.adr.md"
  - "../adrs/0112-telemetry-visibility-startup-warn.adr.md"
  - "../runbooks/0004-token-budget-caps-and-runaway-alerting.runbook.md"
  - "../memories/0026-snapshot-patch-attribution-shared-worktree.memory.md"
---

# Spec: Runaway-Loop Hardening & Telemetry Integrity

## Goal

Eliminate the compaction↔persona-re-anchor doom-loop class (163.7M tokens burned
on 2026-10-03), make telemetry blindness self-announcing, pin session goals against
summarizer confabulation, and fix cross-session patch attribution.

## Phases (workstreams A–F)

- **A.** Re-anchor cap (3/session) + `compaction_recall` marker + recall-first
  prompt + auto-continue cap — `plugin/bensyne/index.ts`, `session/compaction.ts`.
- **B.** Per-`(session, tool, fingerprint)` detector state, cap 64 keys/session,
  default flip true — `plugin/unstuck/cross-stream-doom-loop.ts`, `config.ts`.
- **C.** Immutable Original Task + goal-drift tripwire — `session/compaction.ts`,
  `session/message-v2.ts`.
- **D.** Startup telemetry warn (`core/effect/observability.ts`); ops env fix;
  **D3 → handoff to puma-lan/clickstack session**: LiteLLM spans must show
  non-empty `usage_object` for ≥95% of streaming calls + response-model attribute.
- **E.** Hygiene: gateway budget caps, alerting, idle-session archive policy →
  runbook 0004.
- **F.** Patch attribution: root cause = shared-worktree snapshot diff (memory
  0026); fix = `attributePatchFiles` filter at both emission sites
  (`processor.ts` step-finish + cleanup).

## Status / Behaviors

Implemented on branch `261003-fix-runaway-loop-hardening` (16 files, +1725/−94);
reviewer verdict **PASS WITH CONDITIONS** (214/0 targeted tests re-run
independently, typecheck 15/15). Outstanding: per-task commits owed
(`materials/script-checkpoint-tasks.sh` in session
`261003-2140-openrouter-hack-investigation`); dev-server restart to activate.

## Risks

- Upstream-derived touchpoints (`SUMMARY_TEMPLATE`, `message-v2.ts` schema) widen
  the rebase-conflict surface — resolve at next upstream sync per governance rules.
- B2 default-flip false positives bounded by exact-input fingerprint + evidence
  gate + `doomLoopIgnorePatterns`; monitor first week via
  `cross-stream doom_loop detected` log lines.
- Bash-made file edits become unattributable in patch parts (accepted trade-off,
  reviewer I1).

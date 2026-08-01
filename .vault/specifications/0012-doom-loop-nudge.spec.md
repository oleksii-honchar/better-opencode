---
type: specification
kind: feature
title: "doom_loop → Unstuck Nudge (Allow-then-Catch)"
status: completed
createdAt: "2026-08-01T13:22:43Z"
updatedAt: "2026-08-01T13:22:43Z"
tags: [unstuck, doom-loop, loop-detection, permission, better-opencode]
owner: ""
target: null
see_also:
  - "adrs/0060-allow-then-catch-doom-loop.adr.md"
  - "adrs/0061-dedicated-doom-loop-detection.adr.md"
  - "adrs/0062-doom-loop-permission-allow-default.adr.md"
  - "adrs/0063-no-processor-change-nudge-path.adr.md"
  - "adrs/0064-doom-loop-config-migration.adr.md"
  - "concepts/0007-unstuck-loop-detection.concept.md"
  - "memories/0009-doom-loop-fingerprint-fnv1a.memory.md"
  - "memories/0010-doom-loop-missing-input-run.memory.md"
  - "memories/0011-unstuck-test-default-drift.memory.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Specification: doom_loop → Unstuck Nudge (Allow-then-Catch)

## Goal

Eliminate the raw "Opencode failed to send message with error: …" doom-loop failure by teaching the `unstuck` plugin to detect the 3× same-tool-same-input pattern at stream level and inject a nudge instead of letting the permission layer hard-stop.

## Background

The built-in `doom_loop` permission (3× same tool + same input, `DOOM_LOOP_THRESHOLD = 3` in `session/processor.ts`) resolved to `deny` in the user's effective ruleset → `Permission.DeniedError` escaped the processor (uncatchable by `failToolCall`) → raw error. Unstuck wrapped the model stream but never saw the denial. Implemented via Allow-then-Catch: default permission `allow` + unstuck `doom_loop` detection type.

## Phases (all completed 2026-08-01)

### Phase 1 — Detector + types (core)

- [x] `error.ts`: `"doom_loop"` added to both unions; `doomLoop` added to `EvidenceThresholds`; `LoopDetectedError` message branch naming tool + threshold
- [x] `config.ts` (unstuck): `enableDoomLoopDetection` (true), `doomLoopThreshold` (3), `defaultEvidenceThresholds.doomLoop` (1)
- [x] `loop-detector.ts`: doom_loop detection in `tool-input-end` (3× identical tool+input within step), per-step run record, `isThresholdMet` branch, log points L1–L4, input fingerprint via `fnv1a(JSON.stringify(input))`
- [x] `wrapper.ts`: `defaultNudgeMessage` doom_loop branch, `thresholdKey` → `doomLoop`, L5/L6 toolName fields, L7 config log
- [x] `index.ts`: no export change needed (`LoopDetectedInfo` already exported)

### Phase 2 — Permission default + config schema

- [x] `agent/agent.ts`: `doom_loop: "ask"` → `"allow"`
- [x] `config/config.ts`: `unstuck` schema + `evidenceThresholds` schema extended with the new keys
- [x] `docs/spec/08-unstuck-plugin.md`: config keys, L1–L7 log table, 5 troubleshooting scenarios, new default + migration note

### Phase 3 — Tests

- [x] `loop-detector.test.ts` (+14), `wrapper.test.ts` (+doom_loop suite), `config.test.ts` (unstuck +10, schema +7), `agent.test.ts` (new, 3), `doom-loop.integration.test.ts` (new, 4)
- [x] Scoped runs: unstuck 339 pass / 3 fail (pre-existing baseline, unrelated — see memory 0011); agent+integration+config 26/26; `tsgo --noEmit` clean

### Phase 4 — Config migration + verification (user environment)

- [x] Removed `doom_loop: deny` from 18 source agent files (`opencode/` 8 + `caveman-opencode/` 10), redeployed via `./agents.sh install` → `~/.config/opencode/agents/` (10 agents); `rg doom_loop` → no matches
- [ ] Manual live reproduction of the original raw-error scenario (open follow-up — needs a real session with a doom loop)

## Behaviors

- When a model emits 3 consecutive identical (tool name + exact `JSON.stringify(input)`) tool calls within the current step, unstuck detects `doom_loop` at the 3rd `tool-input-end` — **before** the processor's `tool-call` handler — and fires nudge-and-prune (abort stream → prune looping assistant messages → inject `_unstuckNudge` user message → restart).
- If unstuck is disabled or misses the pattern, the processor's doom_loop check still runs but resolves to `allow` (default) → the tool executes instead of erroring.
- Detection is skipped when input resolution failed (`{ _missing: true }`) and for provider-executed tools.
- No raw tool inputs are logged — L1–L4 use `inputFingerprint` (fnv1a hash) only.

## Risks

- **Explicit `doom_loop: deny` in user config still escapes** (HIGH) — mitigated by mandatory config migration (Phase 4); no processor-level safety net by design.
- **False positives** — 3× same tool+input may be legitimate (e.g., `read` same file) (MEDIUM) — exact-input equality mirrors processor semantics; `enableDoomLoopDetection: false` disables; nudge only restarts, never hard-fails below `maxNudges`.
- **Behavior change** — `ask` prompt disappears by default (MEDIUM) — intentional; users can set `doom_loop: "ask"` explicitly.
- **Interrupted tool parts** — mid-stream nudge aborts calls 1–2 (MEDIUM) — existing nudge-and-prune handles; processor `cleanup` marks incomplete calls.

## Milestones

- 2026-08-01: Spec completed, reviewed (APPROVE WITH COMMENTS), config migration applied.

## Links

- ADRs: 0060–0064; Concept: 0007; Memories: 0009–0011 (gotchas)
- Repo canonical doc: `docs/spec/08-unstuck-plugin.md` (updated 2026-08-01 with doom_loop config, L1–L7 log table, troubleshooting scenarios 4–8, migration steps)

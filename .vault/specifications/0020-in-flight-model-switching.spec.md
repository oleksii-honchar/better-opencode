---
type: specification
id: SPEC-0020
title: "In-flight Model Switching via a `switch_model` Tool"
status: approved
createdAt: "2026-09-01T15:48:45Z"
updatedAt: "2026-09-01T21:16:00Z"
tags: [model-resolution, tool, runloop, agent, v1, v2]
adr_refs:
  - ADR-0100
  - ADR-0101
  - ADR-0102
see_also:
  - "adrs/0100-in-flight-model-switch-tool.adr.md"
  - "concepts/0013-in-flight-model-switching.concept.md"
---

# SPEC-0020: In-flight Model Switching via a `switch_model` Tool

## Goal

Allow an agent, mid-turn, to escalate to a smarter model for the remainder of the task — by
exposing a `switch_model` tool the LLM can call, with a provider-scoped candidate list exposed in
the system prompt. The switch takes effect at the next `runLoop` iteration and becomes the durable
session default.

## Background

Model switching today is turn-granular (client-driven via `prompt()` `model`, TUI dialog,
slash-commands) and spawn-time (config-driven via sub-agent `models:`). There is no in-turn,
agent-driven switch. `runLoop` (prompt.ts) already re-resolves the model from `lastUser.model` each
iteration (~line 1447), so writing a new model onto `lastUser.model` takes effect next iteration.

**Prior art:** the "self-routing" pattern (an agent that can delegate to itself at higher
capability) exists in production systems (e.g. EvoRoute's `self_delegate` tool). Upstream requests
anomalyco/opencode #8278 (tool to switch models), #8456 (config routing), #10633 (community).

## Phases

### Phase 1: Foundation — `smartModels` config field
- [x] Add `smartModels: string[]` to `config/agent.ts` `AgentSchema` + `KNOWN_KEYS` (raw schema).
- [x] Add `smartModels: Model.Ref[]` to `agent/agent.ts` `Info` + parse block (runtime schema).
- [x] Parse via `Provider.parseModel` (reuses the `models:` pattern).

### Phase 2: Foundation — `dynamicModelSwitch` gate
- [x] Add `dynamicModelSwitch?: { enabled?: boolean }` to `config/config.ts` `Config.Info`.
- [x] Read as `cfg.dynamicModelSwitch?.enabled ?? true` at both sites.

### Phase 3: Core — `switch_model` tool
- [x] Create `tool/switch_model.ts` (patterned on `task.ts` via `Tool.define`).
- [x] Add `"switch_model"` to `TOOL_NAMES` in `tool/registry.ts`.
- [x] Conditionally register the tool in `Tool.jsonSchemas` when `dynamicModelSwitch` is enabled.
- [x] Create `tool/switch_model.txt` description.

### Phase 4: Wiring — `Session.Service.setModel`
- [x] Add `setModel` method signature to `session.ts` interface.
- [x] Implement `setModel` (update last user message via `updateMessage` + session row).
- [x] Expose in HTTP server.

### Phase 5: Prompt — inject candidates + guidance
- [x] Modify `system.ts` `environment()` to append `SMART_MODELS:` line + guidance.
- [x] Update `prompt.ts` `systemEnvironment` call to pass `smartModels`.
- [x] Update `system-context.md` prompt tests for the new output.

## Behaviors

### When to switch
- Task complexity is unexpectedly high for the current model.
- Reasoning/analysis quality is insufficient.
- A precise, high-stakes sub-task warrants a stronger model.

### Switching behavior
- `switch_model` validates the target is in the current provider's `smartModels`.
- The model persists to the last user message (drives `runLoop`) AND the session row (durable
  default). `ModelSwitched` is published. The next iteration uses the new model.

## Constraints

- **Provider-scoped:** candidates = `smartModels.filter(m => m.providerID === lastUser.model.providerID)`.
- **Non-breaking:** `createUserMessage` precedence `input.model ?? ag.model ?? currentModel` is
  respected; explicit per-prompt `model` always wins.
- **v1-only:** targets the working v1 loop; the v2 `switchModel` stub is a follow-up.

## Validation

- `switch_model` rejects cross-provider / non-configured targets (allowed list returned).
- `ModelNotFoundError.suggestions` returned for unknown models.
- Feature is a no-op when an agent has no `smartModels` or when `dynamicModelSwitch.enabled === false`.

## Amendment v2 (2026-09-01) — persistence contract + precedence change (D2.5)

Implemented on branch `feat/260901-model-in-flight` (session "Small-Model Session-Rules
Compliance", decision D2.5). Four changes to the v1 record above:

- **Precedence (amends Constraints "explicit per-prompt `model` always wins"):** the contract is
  now **"explicit user re-pin wins"** — the persisted override outranks `input.model`, and only an
  explicit user model selection (TUI model picker, `/model`, ACP selection sites) clears it.
- **`persist: true`:** `switch_model` gains an optional `persist` param; when set it writes a
  **durable session `modelOverride`** (`Session.Service.setModelOverride` / `clearModelOverride`)
  that outranks `input.model` in `prompt.ts` resolution — consulted only when the agent declares a
  `smartModels` scope containing the override model — until the user re-pins.
- **Default `persist: false` keeps v1 semantics:** a switch without `persist` still applies to the
  current turn only (per-turn revert), so v1 consumers are unaffected.
- **Storage correction:** v1 implied session fields need no schema work; that turned out wrong —
  the durable override is a **column**, `SessionTable.model_override` (nullable JSON), added by the
  additive migration `20260901194500_add_session_model_override` (zero backfill), mapped to
  `Session.Info.modelOverride` and persisted by the `SessionEvent.ModelSwitched` projector.

See also the v2 note in [[adrs/0100-in-flight-model-switch-tool.adr.md]] and the amended
`SMART_MODELS:` guidance text in `session/system.ts`.

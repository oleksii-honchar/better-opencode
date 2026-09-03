---
type: adr
id: ADR-0100
title: "In-flight Agent-Driven Model Switching via a `switch_model` Tool"
status: accepted
createdAt: "2026-09-01T15:48:45Z"
updatedAt: "2026-09-03T06:40:00Z"
tags: [model-resolution, tool, runloop, agent, architecture]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0101-provider-scoped-smart-models.adr.md"
  - "adrs/0102-dynamic-model-switch-config-gate.adr.md"
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "concepts/0013-in-flight-model-switching.concept.md"
  - "concepts/0003-llm-turn-management.concept.md"
  - "specifications/0020-in-flight-model-switching.spec.md"
---

# ADR-0100: In-flight Agent-Driven Model Switching via a `switch_model` Tool

## Context

better-opencode supported model switching only at **turn granularity (client-driven)** — via
the `prompt()` API `model` param, the TUI dialog, and slash-commands — and at **spawn-time
(config-driven)** via sub-agent `models:` resolution ([[concepts/0008-agent-model-selection.concept.md]]).
The LLM itself had **no way to decide mid-reasoning that it needed a smarter model and switch**.

This was a known open ask upstream:
- anomalyco/opencode #8278 — "[FEATURE] Tool that lets the model switch models" (closed-as-stale, not implemented).
- anomalyco/opencode #8456 — config-level per-task-type model routing (open).
- anomalyco/opencode #10633 — community demand, points to #8278/#8456.

The working seam already exists: `runLoop` (`session/prompt.ts`) re-resolves the model from the
last user message on **every iteration** — `getModel(lastUser.model.providerID, lastUser.model.modelID, ...)`
at prompt.ts:~1447 — so writing a new model onto `lastUser.model` takes effect next iteration with
**zero changes to the loop**. The `ModelSwitched` event and its TUI/SDK rendering already exist.

## Decision

Implement an agent-callable **`switch_model` tool** (`packages/opencode/src/tool/switch_model.ts`,
patterned on `task.ts` via `Tool.define`) that the LLM invokes with a target model. The tool:
1. Parses the model string with `Provider.parseModel` (the canonical parser).
2. Resolves the current provider from the last user message and scopes candidates to it
   (see [[adrs/0101-provider-scoped-smart-models.adr.md]]).
3. Validates the model exists via `Provider.Service.getModel`, surfacing `ModelNotFoundError.suggestions`
   so the LLM can self-correct.
4. Persists to **both** the last user message (`updateMessage`) AND the session row (new
   `Session.Service.setModel`) so the switch drives the running loop **and** becomes the durable
   session default via `currentModel()` (prompt.ts:~750-766).
5. Publishes `SessionEvent.ModelSwitched`.

Supporting design decisions (folded here):
- **Candidate list exposure:** inject a `SMART_MODELS:` line + switching guidance into
  `SystemPrompt.environment()` (system.ts) — **not** via env vars, which ADR-0022 explicitly
  rejected as inconsistent with opencode config patterns. System-prompt text is how the current
  model is already conveyed ("You are powered by..."), so this respects ADR-0022.
- **Guidance block:** append short "when to switch" guidance so the tool is actually used.
- **Target v1 only:** implement on the working v1 loop; leave the incomplete v2 `switchModel`
  stub (v2/session.ts) for a follow-up. No HTTP/chat-protocol change (the API already accepts a
  per-message `model`).

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Env-var model list + optional model field (user's sketch) | Matches user's initial idea | Env-var half rejected by ADR-0022; neither part lets the *agent* self-act | Agent cannot write its own env mid-stream |
| Extend `runLoop` to re-resolve model from a routing fn per iteration | In-loop | Couples loop semantics to routing; risks breaking pinned-model behavior; less direct | A tool is the only way the LLM itself can act |
| Config-level static routing (upstream #8456) | Static, simple | Not model-driven; doesn't match "the agent decides" | Different goal |

## Consequences

- **Positive:** Agent-driven, client-agnostic, rides an existing seam (zero loop changes). Realizes #8278's ask and the "self-routing" prior art (EvoRoute).
- **Positive:** Non-breaking — `createUserMessage` precedence `input.model ?? ag.model ?? currentModel` (prompt.ts:~786) keeps user-pinned / per-prompt models authoritative.
- **Trade-off:** Switch granularity is the **next loop iteration** (next LLM stream), not mid-stream — provider streams execute provider-side tools internally.
- **Guarded by:** provider-scoped `smartModels` ([[adrs/0101-provider-scoped-smart-models.adr.md]]) and the `dynamicModelSwitch` gate ([[adrs/0102-dynamic-model-switch-config-gate.adr.md]]).
- **Status note:** Implemented and reviewer-verified on branch `feat/260901-model-in-flight` (commit `5fbe5024d`).
- **v2 note (2026-09-01, D2.5):** the persistence contract gained an explicit opt-in —
  `switch_model persist: true` writes a **durable session `modelOverride`** (column
  `SessionTable.model_override` + additive migration `20260901194500_add_session_model_override`)
  that outranks `input.model` until an explicit user re-pin clears it; the default (no `persist`)
  keeps the v1 per-turn behavior. The v1 "explicit per-prompt model always wins" precedence
  (Decision item 4 / Consequences above) is amended to **"explicit user re-pin wins"** — full
  record in [[specifications/0020-in-flight-model-switching.spec.md]] (Amendment v2).
- **v3 note (2026-09-03):** the tool now supports **switch-back to the session's original model**
  (recorded in `SessionTable.model_original`; see [[adrs/0101-provider-scoped-smart-models.adr.md]]
  Amendment). The original model is carved out of the smart-only candidate rule, exposed to the
  agent as `ORIGINAL_MODEL:` in the environment, and a persisted switch-back clears any prior
  override. ADR-0101 and SPEC-0020 (Amendment v3) carry the full record.

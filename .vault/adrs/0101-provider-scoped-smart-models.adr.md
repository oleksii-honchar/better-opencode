---
type: adr
id: ADR-0101
title: "Provider-Scoped `smartModels` as the In-flight Switch Candidate Set"
status: accepted
createdAt: "2026-09-01T15:48:45Z"
updatedAt: "2026-09-04T12:35:00Z"
tags: [model-resolution, configuration, provider, agent]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0100-in-flight-model-switch-tool.adr.md"
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "concepts/0013-in-flight-model-switching.concept.md"
  - "specifications/0020-in-flight-model-switching.spec.md"
---

# ADR-0101: Provider-Scoped `smartModels` as the In-flight Switch Candidate Set

## Context

For the `switch_model` tool ([[adrs/0100-in-flight-model-switch-tool.adr.md]]) to be usable and safe,
the agent must know which models it may switch to. The user required that switching **respect the
current provider** — an agent on a provider-`P` model should see/switch only to its smart model for
provider `P`, never across providers. The candidate set is also the natural **cost guardrail**
that justifies default-on (ADR-0102).

## Decision

- Add a per-agent **`smartModels: string[]`** config field (raw `provider/modelID[:variant]`
  strings), parsed to `{modelID, providerID, variant?}[]` via `Provider.parseModel`, mirroring the
  existing `models:` field. This is the **source of switch candidates** (user-curated).
  - Raw schema: `config/agent.ts` `AgentSchema` + `KNOWN_KEYS`.
  - Runtime schema: `agent/agent.ts` `Info` + parse block.
- **Current provider** = the running model's provider = `lastUser.model.providerID`.
- **Candidate set** = `smartModels.filter(m => m.providerID === currentProvider)`.
  - The system-prompt `SMART_MODELS:` line shows only these.
  - The `switch_model` tool validates the target is in this set; cross-provider or
    non-configured targets are rejected with the allowed list.
- Consequence: the agent **cannot switch providers** via `switch_model`.

```yaml
# Example (per-agent):
models: [p1/fast]        # default model for this agent
smartModels: [p1/smart]  # smart model for provider p1 → only visible while running on p1
```

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Cross-provider candidate set | More flexibility | Violates the user's provider-scoping requirement | Intentionally rejected |
| Auth-filtered catalog as source | No config needed | Too broad, not curated, ignores provider intent, cost risk | Not curated |
| Static single `smartModel` field | Simpler | Breaks when an agent spans providers | User's design is per-provider |

## Consequences

- **Positive:** Small, curated, provider-consistent candidate set; strong cost guardrail; preserves provider-specific credentials/behavior and prompt-cache locality.
- **Positive:** Reuses `Provider.parseModel` + the `models:` parsing pattern — no new resolution logic.
- **Trade-off:** Users must configure `smartModels` per agent for the feature to do anything; an agent with none is a no-op for switching (safe).
- **Trade-off:** Cross-provider escalation is intentionally impossible via this tool.

## Amendment 2026-09-04 — v4: switch-back fix (capture-before-validation, canonical-at-create, re-pin resets original, persist gating)

Supersedes the 2026-09-03 Amendment.

### The bug

The v3 design (switch-back to original) was correct, but the **ordering** of original-capture was wrong: `switch_model` recorded `model_original` **post-validation** on first non-switch-back escalation. This meant:

1. A session whose very first `switch_model` call targeted the original model (switch-back) deadlocked — validation ran before the original was recorded, so the original was never in the allowed list.
2. A legacy session with a polluted `session.model` (prior `setModel` call had overwritten it to the smart model) could never recover the true original — the `originalModel` fallback read `session.model`, which was already the smart model.

### The fix (ADR-0106 through ADR-0110)

**ADR-0106 — Capture original before validation:** In `switch_model`, resolve the pre-switch original from the **first user message's model** (which truthfully carries the session's starting model) and record it via `setModelOriginal` **before** allowed-list validation. This fixes both the first-call switch-back deadlock and the polluted-`session.model` recovery.

**ADR-0107 — Pin original at session creation:** `Session.createNext` now sets `modelOriginal: input.modelOriginal ?? input.model` — every session records its original at birth. The migration + P1 remain as healing/backstop for pre-change sessions.

**ADR-0108 — Additive backfill migration:** New migration `2026090312xxxx_add_backfill_session_model_original` sets `model_original` from the first user message's model for all existing rows with `model_original IS NULL`. Idempotent, never touches `session.model` or `model_override`.

**ADR-0109 — Re-pin resets original (human-approved):** User model-re-pin sites (TUI picker, `/model`, ACP selection) that clear `modelOverride` now also set `model_original` to the chosen model. Switch-back, env, and allowed-list all track the user's latest choice after re-pin.

**ADR-0110 — Gate `setModel` on `persist` + flip default to `persist:false` (human-approved):** `switch_model` schema's `persist` field now defaults to `false`. `persist:false` (or omitted) writes only `updateMessage`; durable `session.model` is unchanged. `persist:true` writes durable `session.model` as today. `model_original` is untouched by either branch. This stops the "per-turn smart switch leaks into durable default" bug.

### Consequences

- The reported switch-back deadlock is fixed. First-call switch-back works. Legacy polluted sessions are healed by migration.
- The `ORIGINAL_MODEL` env line is truthful from turn 1 (pinned at creation).
- Agents must explicitly escalate with `persist: true` for session-wide persistence — per-turn switches no longer pollute the durable default.
- The `smartModels` guardrail is preserved: switch-back to the session's own original is still the only non-smart allowed target.

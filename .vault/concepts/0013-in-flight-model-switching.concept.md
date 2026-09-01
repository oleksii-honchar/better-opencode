---
type: concept
id: CONCEPT-0013
title: "In-flight Model Switching"
summary: "Agent-driven model switching mid-turn via a `switch_model` tool that rides the runLoop's per-iteration model re-resolution."
status: active
createdAt: "2026-09-01T15:48:45Z"
updatedAt: "2026-09-01T15:48:45Z"
tags: [model-resolution, tool, runloop, agent]
see_also:
  - "concepts/0007-model-resolution-order.concept.md"
  - "concepts/0003-llm-turn-management.concept.md"
  - "concepts/0008-agent-model-selection.concept.md"
  - "adrs/0100-in-flight-model-switch-tool.adr.md"
  - "specifications/0020-in-flight-model-switching.spec.md"
---

# In-flight Model Switching

An agent-driven mechanism that lets the LLM, **mid-reasoning**, switch to a smarter (or different)
model for the remainder of the task. Implemented in better-opencode as a `switch_model` tool
(ADR-0100) riding the `runLoop`'s per-iteration model re-resolution.

## Key Details

### The three switching granularities

| Granularity | Actor | Mechanism |
|-------------|-------|-----------|
| Turn (client-driven) | User/SDK | `prompt()` `model` param, TUI dialog, slash-commands |
| Spawn-time (config) | Config | Sub-agent `models:` resolution (CONCEPT-0008) |
| **In-flight (agent-driven)** | **LLM** | **`switch_model` tool (this concept)** |

### Mechanism

1. `runLoop` (`session/prompt.ts`) re-resolves the model from `lastUser.model` **each iteration** —
   `getModel(lastUser.model.providerID, lastUser.model.modelID)` at prompt.ts:~1447.
2. The `switch_model` tool writes the target model to **both** the last user message (`updateMessage`)
   and the session row (`Session.Service.setModel`) → takes effect next iteration AND becomes the
   durable default via `currentModel()` (prompt.ts:~750-766).
3. `ModelSwitched` is published (existing event).
4. **Provider-scoped candidates** (ADR-0101): `smartModels.filter(m => m.providerID === lastUser.model.providerID)`.
5. **Gated** by `dynamicModelSwitch.enabled ?? true` (ADR-0102, root config, default-on).

### Granularity caveat

The switch applies at the **next LLM stream** (next loop iteration), not mid-stream: provider
streams execute provider-side tools internally and are opaque.

### "Self-routing" prior art

The pattern — an agent delegating to itself at higher capability — is used in production routing
systems (e.g. EvoRoute's `self_delegate` tool). better-opencode's `switch_model` is an
in-process, provider-scoped, cost-guarded version.

### Guardrails

- Provider-scoping limits cost/credential blast radius.
- `ModelNotFoundError.suggestions` lets the LLM self-correct typos.
- Default-on is safe because the candidate set is user-curated (no open-ended catalog).

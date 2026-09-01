---
type: adr
id: ADR-0101
title: "Provider-Scoped `smartModels` as the In-flight Switch Candidate Set"
status: accepted
createdAt: "2026-09-01T15:48:45Z"
updatedAt: "2026-09-01T15:48:45Z"
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

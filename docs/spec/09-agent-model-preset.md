# 09-agent-model-preset

## Context

Currently, better-opencode supports only two LLM parameters per agent: `temperature` and `top_p`. These are defined in the agent config schema (`packages/opencode/src/config/agent.ts` lines 27-28) and applied with agent-level precedence in the LLM call (`packages/opencode/src/session/llm.ts` lines 171-174).

When using llama-swap as an openai-compatible provider, the `setParamsByID` filter in llama-swap config (e.g., `config-1.yaml:153-162`) defines a rich set of per-model parameters:

```yaml
temperature: 1.0
top_p: 0.95
top_k: 20
min_p: 0.0
presence_penalty: 1.5
repeat_penalty: 1.0
reasoning-budget: 4096
chat_template_kwargs:
  enable_thinking: true
  preserve_thinking: true
```

A user may want to use the same base model for chat but change parameters for a sub-agent (e.g., lower temperature + disable thinking for a precise coding agent). Currently this is only possible via `temperature` and `top_p` in the agent frontmatter. The other parameters (`presence_penalty`, `repeat_penalty`, `min_p`, `top_k`, `reasoning-budget`, `chat_template_kwargs`) are **not supported per-agent**.

The openai-chat protocol schema (`packages/llm/src/protocols/openai-chat.ts` lines 84-91) supports `temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `max_tokens`, `stop`, `seed` — but the agent config schema only exposes `temperature` and `top_p`. The `options` catch-all field in the agent config is merged into `providerOptions` but `lowerOptions` in the openai-chat protocol only passes through `store` and `reasoning_effort`.

The llama-swap specific parameters (`repeat_penalty`, `min_p`, `top_k`, `reasoning-budget`, `chat_template_kwargs`) are **not in the openai-chat protocol schema** — they are handled by llama-swap's `setParamsByID` filter, not by the openai-compatible API.

## Problem

Users cannot define per-agent LLM parameters beyond `temperature` and `top_p`. This forces them to either:

1. Define separate model IDs in llama-swap for each parameter combination (e.g., `qwopus35-27b-tq3-precise`), then assign different `model` per agent — works but requires managing model aliases in llama-swap
2. Use the same model for all agents and accept the same parameters — limits flexibility

The user's goal: **same base model for chat, different parameters per sub-agent, without needing separate model IDs in llama-swap**.

## Solution: modelPreset

The originally proposed solution was a full `llm_params` field accepting arbitrary parameter overrides. After investigation, a simpler approach was chosen: **delegate parameter tuning entirely to llama-swap** rather than piping parameters through opencode.

The `modelPreset` field appends a known suffix (`-precise`, `-instruct`) to the inherited session model ID, then looks up the suffixed model in the provider (e.g., llama-swap). All parameter tuning lives in llama-swap model definitions — opencode only controls *which* model variant is selected.

This approach:
- **Simpler** — no parameter schema extension, no merging logic in llm.ts
- **Less fragile** — no risk of provider-specific params being silently dropped
- **Delegated** — llama-swap owns all parameter tuning; opencode just picks the model name

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Config                              │
│                                                             │
│  model: openai-compatible/qwopus35-27b-tq3                  │
│  temperature: 0.6        ← direct field (existing)          │
│  top_p: 0.95             ← direct field (existing)          │
│  modelPreset: "precise"  ← NEW field (closed set)           │
│                                                             │
│  Values: "precise" | "instruct"                             │
│  Only applies when agent inherits model from session.       │
│  Explicit `model` takes precedence.                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              resolveAgentModel() helper                      │
│                                                             │
│  if (agent.model)      → use agent.model                    │
│  if (agent.modelPreset) → `${parentModel.modelID}-`+preset   │
│  else                  → parentModel                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    LLM Request                               │
│                                                             │
│  model: "qwopus35-27b-tq3-precise"                          │
│                                                             │
│  llama-swap resolves → params from setParamsByID filter     │
│  (temperature, top_p, top_k, min_p, repeat_penalty,        │
│   reasoning-budget, chat_template_kwargs, etc.)              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ (if suffixed model not found)
┌─────────────────────────────────────────────────────────────┐
│              Fallback Behavior                               │
│                                                             │
│  If provider throws ModelNotFoundError for suffixed ID:     │
│    → elog.warn("modelPreset suffix not found")              │
│    → Fall back to parent (base) model                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Model Resolution Flow

```
agent.model (explicit)
  → agent.modelPreset + parentModel.modelID (suffixed)
    → parentModel (fallback)
```

1. **Explicit `model` set on agent**: Use it directly. `modelPreset` is ignored.
2. **No explicit `model`, `modelPreset` set**: Compute `${parentModel.providerID}/${parentModel.modelID}-${modelPreset}`. Try to resolve with provider.
3. **Suffixed model not found**: Log a warning, fall back to the base (parent) model. Does NOT error — prevents workflow breaks when suffixed model isn't yet defined in llama-swap.
4. **Neither `model` nor `modelPreset` set**: Inherit parent model unchanged.

### Component Design

#### 1. Agent Config Schema — `config/agent.ts`

Added `modelPreset` field to `AgentSchema` (line 43-46):

```typescript
modelPreset: Schema.optional(Schema.Literals(["precise", "instruct"])).annotate({
  description:
    "Appends a suffix to the inherited model ID (e.g., -precise, -instruct). Only applies when the agent inherits its model from the parent session.",
}),
```

Added `modelPreset` to `KNOWN_KEYS` (line 74) so it doesn't get promoted to `options` during normalization.

**Backward compatibility**: Existing agents without `modelPreset` work unchanged. The field is optional.

#### 2. Agent Info Schema — `agent/agent.ts`

Added `modelPreset` to the `Info` schema (line 44):

```typescript
modelPreset: Schema.optional(Schema.Literals(["precise", "instruct"])),
```

The config resolution loop at line 299 propagates the field:

```typescript
item.modelPreset = value.modelPreset ?? item.modelPreset
```

Exported `resolveAgentModel()` helper (lines 466-479):

```typescript
export function resolveAgentModel(
  agentModel: Info["model"],
  agentModelPreset: Info["modelPreset"],
  parentModel: { providerID: ProviderID; modelID: ModelID },
): { modelID: ModelID; providerID: ProviderID } {
  if (agentModel) return agentModel
  if (agentModelPreset) {
    return {
      modelID: ModelID.make(`${parentModel.modelID}-${agentModelPreset}`),
      providerID: parentModel.providerID,
    }
  }
  return parentModel
}
```

#### 3. Primary Agent Model Resolution — `session/prompt.ts`

In `createUserMessage` (lines 1210-1226):

```typescript
const current = Database.use((db) =>
  db
    .select({ agent: SessionTable.agent, model: SessionTable.model })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get(),
)
const parentModel = yield* currentModel(input.sessionID)
let model: { providerID: ProviderID; modelID: ModelID }
if (input.model) {
  model = input.model
} else if (ag.model) {
  model = ag.model
} else if (ag.modelPreset) {
  const resolved = Agent.resolveAgentModel(ag.model, ag.modelPreset, {
    providerID: parentModel.providerID,
    modelID: parentModel.modelID,
  })
  const exit = yield* provider.getModel(resolved.providerID, resolved.modelID).pipe(Effect.exit)
  if (Exit.isSuccess(exit)) {
    model = resolved
  } else {
    const err = Cause.squash(exit.cause)
    if (Provider.ModelNotFoundError.isInstance(err)) {
      elog.warn(
        `modelPreset "${ag.modelPreset}" produced model "${resolved.providerID}/${resolved.modelID}" which was not found — falling back to base model`,
      )
      model = { providerID: parentModel.providerID, modelID: parentModel.modelID }
    } else {
      return yield* Effect.die(err)
    }
  }
}
```

Key behavior:
- Only applies when the agent has no explicit `model`
- Catches `ModelNotFoundError` specifically — other errors propagate as deaths
- Falls back to base (parent) model on missing suffixed model with a warning

#### 4. Sub-Agent Model Resolution — `tool/task.ts`

The sub-agent model resolution also uses `resolveAgentModel()` to compute the model for spawned sub-agents, ensuring consistency between primary and sub-agent model selection.

### Agent Config Example

```yaml
---
mode: subagent
modelPreset: "precise"
---

You are a precise coding agent. Generate code directly without reasoning.
```

In llama-swap config, define the suffixed model with desired parameters:

```yaml
model-aliases:
  qwopus3.6-27b-precise:
    - base-model: qwopus3.6-27b-tq3
    - parameters:
        temperature: 0.3
        top_p: 0.9
        chat_template_kwargs:
          enable_thinking: false
          preserve_thinking: false
```

### Schema Reference

```typescript
interface AgentConfig {
  // ... existing fields
  model?: string                          // Explicit model (takes precedence)
  modelPreset?: "precise" | "instruct"   // Suffix for inherited model
  temperature?: number                    // Existing direct field
  top_p?: number                          // Existing direct field
}
```

### Precedence

```
agent.model (explicit)
  → agent.modelPreset + parentModel (suffixed)
    → parentModel (fallback if suffixed not found)
```

If both `model` and `modelPreset` are set, `model` wins. `modelPreset` only applies when the agent inherits its model from the session.

### Implementation Status

**Completed.** All 4 source files modified, 5 unit tests passing (typecheck 14/14).

#### Files Modified

| File | Change | Lines |
|------|--------|-------|
| `packages/opencode/src/config/agent.ts` | Added `modelPreset` to `AgentSchema` + `KNOWN_KEYS` | 43-46, 74 |
| `packages/opencode/src/agent/agent.ts` | Added `modelPreset` to `Info` schema + exported `resolveAgentModel()` | 44, 299, 466-479 |
| `packages/opencode/src/session/prompt.ts` | Full modelPreset resolution with fallback + warning | 1210-1226 |
| `packages/opencode/src/tool/task.ts` | Sub-agent model resolution via `resolveAgentModel()` | — |

#### Tests

| File | Tests | Coverage |
|------|-------|----------|
| `packages/opencode/test/agent/resolve-agent-model.test.ts` | 5 | All 4 resolution paths + provider ID inheritance |

Test cases:
1. Explicit `model` takes precedence over `modelPreset`
2. `modelPreset: "precise"` computes suffixed model ID
3. `modelPreset: "instruct"` computes suffixed model ID
4. No model, no preset → returns parent model
5. Provider ID inherited from parent model

### Original Spec: llm_params (Superseded)

The original solution proposed a `llm_params` field accepting all standard openai-compatible parameters plus provider-specific overrides, merged into the LLM request with agent-level precedence. This approach was abandoned in favor of `modelPreset` because:

1. **Fragile parameter piping** — Provider-specific params (llama-swap's `repeat_penalty`, `min_p`, `top_k`, `reasoning_budget`, `chat_template_kwargs`) are not part of the openai-chat protocol schema and require careful routing through `providerOptions`
2. **Schema bloat** — The agent config becomes a dumping ground for inference parameters that really belong to the model provider
3. **Conflicts** — Same param in direct field and `llm_params` requires precedence rules and warning logic
4. **Duplication** — Parameters defined in both agent config and llama-swap create inconsistency

The `modelPreset` approach avoids all these issues by delegating parameter tuning entirely to llama-swap.

### Key Decisions

1. **`modelPreset` over `llm_params`** — Delegates parameter tuning to llama-swap; opencode only selects the model name variant
2. **Closed set of presets** — Only `"precise"` and `"instruct"`; adding new presets requires a config change, preventing drift
3. **Fallback-to-base with warning** — Missing suffixed model doesn't break the workflow; warns and falls back to parent model
4. **Explicit `model` wins over `modelPreset`** — Clear precedence: explicit > computed > inherited
5. **No changes to llm.ts** — The LLM request layer is untouched; model resolution happens before the LLM call in prompt.ts

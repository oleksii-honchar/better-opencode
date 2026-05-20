# 09-agent-llm-params-per-agent

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

## Solution: Extend Agent Config with LLM Params

Add a `llm_params` field to the agent config schema that accepts all standard openai-compatible parameters plus provider-specific overrides. These parameters are merged into the LLM request with agent-level precedence (agent params override model defaults).

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Config                              │
│                                                             │
│  model: openai-compatible/qwopus35-27b-tq3                  │
│  temperature: 0.6        ← direct field (existing)          │
│  top_p: 0.95             ← direct field (existing)          │
│  llm_params:             ← NEW field                        │
│    presence_penalty: 1.5                                     │
│    frequency_penalty: 0.0                                    │
│    max_tokens: 8192                                          │
│    seed: 42                                                  │
│    stop: ["\n\nHuman:"]                                      │
│    provider:                                                 │
│      openaiCompatible:                                       │
│        repeat_penalty: 1.0                                   │
│        min_p: 0.0                                            │
│        top_k: 20                                             │
│        reasoning_budget: 4096                                │
│        chat_template_kwargs:                                 │
│          enable_thinking: false                              │
│          preserve_thinking: false                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                    LLM Request (llm.ts)                      │
│                                                             │
│  temperature: agent.temperature ?? model.default             │
│  topP: agent.topP ?? model.default                          │
│  presencePenalty: agent.llm_params.presence_penalty          │
│  frequencyPenalty: agent.llm_params.frequency_penalty        │
│  maxTokens: agent.llm_params.max_tokens ?? model.default     │
│  seed: agent.llm_params.seed                                 │
│  stop: agent.llm_params.stop                                 │
│  providerOptions: merge(model.options, agent.llm_params)     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                    OpenAI Chat Body                          │
│                                                             │
│  {                                                           │
│    model: "qwopus35-27b-tq3",                                │
│    temperature: 0.6,                                         │
│    top_p: 0.95,                                              │
│    presence_penalty: 1.5,                                    │
│    frequency_penalty: 0.0,                                   │
│    max_tokens: 8192,                                         │
│    seed: 42,                                                 │
│    stop: ["\n\nHuman:"],                                     │
│    providerOptions: {                                        │
│      openaiCompatible: {                                     │
│        repeat_penalty: 1.0,                                  │
│        min_p: 0.0,                                           │
│        top_k: 20,                                            │
│        reasoning_budget: 4096,                               │
│        chat_template_kwargs: {                               │
│          enable_thinking: false,                             │
│          preserve_thinking: false                            │
│        }                                                     │
│      }                                                       │
│    }                                                         │
│  }                                                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Component Design

#### 1. Agent Config Schema — `config/agent.ts`

Add `llm_params` field to `AgentSchema`:

```typescript
const LLMParamsSchema = Schema.Struct({
  // Standard openai-compatible params (from openai-chat protocol)
  temperature: Schema.optional(Schema.Finite),
  top_p: Schema.optional(Schema.Finite),
  top_k: Schema.optional(Schema.Finite),
  min_p: Schema.optional(Schema.Finite),
  presence_penalty: Schema.optional(Schema.Finite),
  frequency_penalty: Schema.optional(Schema.Finite),
  repeat_penalty: Schema.optional(Schema.Finite),
  max_tokens: Schema.optional(Schema.Finite),
  seed: Schema.optional(Schema.Finite),
  stop: Schema.optional(Schema.Union([
    Schema.String,
    Schema.Array(Schema.String),
  ])),
  // Reasoning models
  reasoning_budget: Schema.optional(Schema.Finite),
  reasoning_effort: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  // Chat template kwargs (llama-swap specific, passed via providerOptions)
  chat_template_kwargs: Schema.optional(Schema.Struct({
    enable_thinking: Schema.optional(Schema.Boolean),
    preserve_thinking: Schema.optional(Schema.Boolean),
  })),
  // Provider-specific overrides (passed via providerOptions)
  provider: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})

const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.optional(ConfigModelID),
    variant: Schema.optional(Schema.String),
    temperature: Schema.optional(Schema.Finite),
    top_p: Schema.optional(Schema.Finite),
    prompt: Schema.optional(Schema.String),
    // NEW field
    llm_params: Schema.optional(LLMParamsSchema),
    // ... rest of existing fields
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)
```

**Backward compatibility**: The existing `temperature` and `top_p` fields remain as direct fields. If both `temperature` (direct) and `llm_params.temperature` are set, the direct field takes precedence (explicit wins over nested). This avoids breaking existing agent configs.

#### 2. LLM Request — `session/llm.ts`

Merge agent `llm_params` into the LLM request params with proper precedence:

```typescript
const agentParams = input.agent.llmParams ?? {}

const params = yield* plugin.trigger(
  "chat.params",
  { /* ... */ },
  {
    // Direct fields take precedence over llm_params
    temperature: input.model.capabilities.temperature
      ? (input.agent.temperature ?? agentParams.temperature ?? ProviderTransform.temperature(input.model))
      : undefined,
    topP: input.agent.topP ?? agentParams.top_p ?? ProviderTransform.topP(input.model),
    topK: agentParams.top_k ?? ProviderTransform.topK(input.model),
    presencePenalty: agentParams.presence_penalty,
    frequencyPenalty: agentParams.frequency_penalty,
    repeatPenalty: agentParams.repeat_penalty,
    minP: agentParams.min_p,
    maxOutputTokens: agentParams.max_tokens ?? ProviderTransform.maxOutputTokens(input.model, flags.outputTokenMax),
    seed: agentParams.seed,
    stop: agentParams.stop,
    reasoningBudget: agentParams.reasoning_budget,
    reasoningEffort: agentParams.reasoning_effort,
    options: mergeOptions(base, agentParams.provider ?? {}),
  },
)
```

The `chat_template_kwargs` and any `provider` overrides are passed through `providerOptions` so they reach the provider-specific handler.

#### 3. Provider Transform — `provider/transform.ts`

Extend `providerOptions` to handle llama-swap specific params:

```typescript
export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
  // Extract llama-swap specific params that don't belong in the openai-chat body
  const llamaSwapParams = {
    repeat_penalty: options.repeat_penalty,
    min_p: options.min_p,
    top_k: options.top_k,
    reasoning_budget: options.reasoning_budget,
    chat_template_kwargs: options.chat_template_kwargs,
  }

  // Filter out undefined values
  const filteredLlamaSwap = Object.fromEntries(
    Object.entries(llamaSwapParams).filter(([_, v]) => v !== undefined)
  )

  // Route to provider-specific namespace
  if (model.api.npm === "@ai-sdk/openai-compatible") {
    return {
      openaiCompatible: {
        ...filteredLlamaSwap,
        ...options,
      },
    }
  }

  // ... existing logic for other providers
}
```

#### 4. OpenAI Chat Protocol — `llm/src/protocols/openai-chat.ts`

The openai-chat protocol already supports `presence_penalty`, `frequency_penalty`, `max_tokens`, `seed`, `stop` in the body schema (lines 84-91). The `fromRequest` function already maps these from `generation` to the body (lines 270-276). No changes needed — just ensure the LLM request includes these fields.

For llama-swap specific params (`repeat_penalty`, `min_p`, `top_k`, `reasoning_budget`, `chat_template_kwargs`), they are passed via `providerOptions` and handled by the openai-compatible provider's `lowerOptions` or by llama-swap's `setParamsByID` filter.

### Agent Config Example

```yaml
---
mode: subagent
model: openai-compatible/qwopus35-27b-tq3
temperature: 0.6
top_p: 0.95
llm_params:
  presence_penalty: 0.0
  frequency_penalty: 0.0
  max_tokens: 8192
  seed: 42
  reasoning_budget: 2096
  chat_template_kwargs:
    enable_thinking: false
    preserve_thinking: false
  provider:
    openaiCompatible:
      repeat_penalty: 1.0
      min_p: 0.0
      top_k: 20
---

You are a precise coding agent. Generate code directly without reasoning.
```

### Parameter Precedence

```
agent.temperature (direct field)
  → agent.llm_params.temperature
    → ProviderTransform.temperature(model)
      → undefined (provider default)
```

Same for all parameters: **direct field > llm_params > model default > provider default**.

### Configuration Schema

```typescript
interface LLMParams {
  // Standard openai-compatible params
  temperature?: number
  top_p?: number
  top_k?: number
  min_p?: number
  presence_penalty?: number
  frequency_penalty?: number
  repeat_penalty?: number
  max_tokens?: number
  seed?: number
  stop?: string | string[]
  
  // Reasoning models
  reasoning_budget?: number
  reasoning_effort?: "low" | "medium" | "high"
  
  // Chat template kwargs (llama-swap specific)
  chat_template_kwargs?: {
    enable_thinking?: boolean
    preserve_thinking?: boolean
  }
  
  // Provider-specific overrides
  provider?: Record<string, any>
}
```

### Parameter Reference

| Parameter | Type | OpenAI Body? | ProviderOptions? | Description |
|-----------|------|-------------|------------------|-------------|
| `temperature` | number | ✅ | — | Controls randomness (0-2) |
| `top_p` | number | ✅ | — | Nucleus sampling threshold (0-1) |
| `top_k` | number | ❌ | ✅ | Sample from top K tokens (llama-swap) |
| `min_p` | number | ❌ | ✅ | Min probability threshold (llama-swap) |
| `presence_penalty` | number | ✅ | — | Penalize new tokens based on presence (-2 to 2) |
| `frequency_penalty` | number | ✅ | — | Penalize new tokens based on frequency (-2 to 2) |
| `repeat_penalty` | number | ❌ | ✅ | Penalize repeated tokens (llama-swap) |
| `max_tokens` | number | ✅ | — | Max output tokens |
| `seed` | number | ✅ | — | Random seed for reproducibility |
| `stop` | string\|string[] | ✅ | — | Stop sequences |
| `reasoning_budget` | number | ❌ | ✅ | Max reasoning tokens (llama-swap) |
| `reasoning_effort` | "low"\|"medium"\|"high" | ✅ | — | Reasoning effort level (OpenAI) |
| `chat_template_kwargs.enable_thinking` | boolean | ❌ | ✅ | Enable thinking mode (llama-swap) |
| `chat_template_kwargs.preserve_thinking` | boolean | ❌ | ✅ | Preserve thinking in output (llama-swap) |

### Implementation Plan

#### Phase 1: Schema Extension
- [ ] Add `LLMParamsSchema` to `config/agent.ts`
- [ ] Add `llm_params` field to `AgentSchema`
- [ ] Add `llmParams` field to `Agent.Info` in `agent/agent.ts`
- [ ] Wire `llm_params` through agent resolution (line 301-310 in `agent/agent.ts`)

#### Phase 2: LLM Request Integration
- [ ] Extend `chat.params` plugin trigger in `session/llm.ts` to include new params
- [ ] Add precedence logic: direct field > llm_params > model default
- [ ] Pass provider-specific params through `providerOptions`

#### Phase 3: Provider Transform
- [ ] Extend `providerOptions` in `provider/transform.ts` to handle llama-swap specific params
- [ ] Ensure `chat_template_kwargs` and `provider` overrides reach the provider

#### Phase 4: OpenAI Chat Protocol
- [ ] Verify `fromRequest` in `openai-chat.ts` maps all new params from `generation` to body
- [ ] Ensure `lowerOptions` passes provider-specific params through

#### Phase 5: Tests
- [ ] Unit tests for `LLMParamsSchema` validation
- [ ] Integration tests for agent → LLM request param flow
- [ ] Test precedence: direct field vs llm_params vs model default
- [ ] Test provider-specific params reach llama-swap

### Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Breaking existing agent configs** — adding `llm_params` changes schema | Medium | Direct fields (`temperature`, `top_p`) remain unchanged; `llm_params` is optional; backward compatible |
| **Param conflicts** — same param in direct field and `llm_params` | Low | Explicit precedence: direct field > llm_params > model default; log warning if both set |
| **Provider-specific params ignored** — llama-swap params not reaching the provider | High | Pass through `providerOptions` with explicit `openaiCompatible` key; test with real llama-swap |
| **Schema too broad** — accepting arbitrary params could mask typos | Low | Use strict schema for known params; `provider` field for arbitrary overrides |

### Key Decisions

1. **`llm_params` nested field over top-level fields** — Keeps the agent config clean; avoids schema bloat; groups all LLM params together
2. **Direct fields take precedence over `llm_params`** — Backward compatible; explicit wins over nested
3. **Provider-specific params via `provider` sub-field** — Clean separation between standard openai-compatible params and provider-specific overrides
4. **`chat_template_kwargs` as first-class field** — Common enough for llama-swap users to warrant a dedicated field rather than burying it in `provider`
5. **No changes to openai-chat protocol** — The protocol already supports most params; only `providerOptions` needs extension for llama-swap specific params

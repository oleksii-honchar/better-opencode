---
type: adr
id: ADR-0022
title: "Add models: Field to Agent Configuration"
status: accepted
createdAt: "2026-07-06T13:15:00Z"
updatedAt: "2026-07-06T13:15:00Z"
tags: [agent, model-resolution, configuration]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0023-resolution-priority.adr.md"
  - "adrs/0024-exact-provider-match.adr.md"
  - "concepts/0008-agent-model-selection.concept.md"
  - "specifications/0005-multi-provider-model-setup.spec.md"
---

# ADR-0022: Add models: Field to Agent Configuration

## Context

The current architecture supports a single model per agent (`model:`) or a suffix-based model variant (`modelPreset:`). Neither supports multi-provider selection. The `models:` field uses `provider/modelID` strings that map directly to the existing `Provider.parseModel()` function.

## Decision

Add a `models:` field to AgentSchema and Info schema that accepts an array of provider-prefixed model ID strings. The field is optional and backward-compatible.

```yaml
models:
  - mammoth/qwen3.6-40b
  - deepseek/deepseek-v4-flash
  - codex/gpt-5
```

Each entry is parsed by `Provider.parseModel` into `{ providerID, modelID }` objects.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Map/object format | `{ mammoth: "qwen3.6-40b" }` — clear provider→model mapping | More complex to configure and parse | Array format simpler and consistent with existing patterns |
| Provider-aware agent names | `agent-mammoth`, `agent-deepseek` | Breaks agent name convention, duplicates config | Unmaintainable at scale |
| Environment variable | `AGENT_MODEL_{PROVIDER}=...` | No config change needed | Inconsistent with opencode configuration patterns |
| Parent provider inheritance | Always inherit parent provider and model | Zero config | Loses provider-specific model selection |

## Consequences

- **Positive:** Agents can automatically select optimal models per provider; session agents choose provider without sub-agent config changes; future-proof for new providers
- **Negative:** Slightly more complex configuration schema; new field to document and maintain
- **Neutral:** Existing `model:` and `modelPreset:` continue to work unchanged

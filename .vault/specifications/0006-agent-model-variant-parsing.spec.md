---
type: specification
title: "Agent Model `:variant` Parsing"
kind: feature
status: completed
createdAt: "2026-07-09T10:30:00Z"
updatedAt: "2026-07-09T10:30:00Z"
tags: [agent, model-resolution, parsing, variant]
owner: ""
target: null
see_also:
  - "adrs/0027-parse-model-variant-return-type.adr.md"
  - "adrs/0028-inline-variant-precedence.adr.md"
  - "adrs/0029-colon-as-variant-separator.adr.md"
  - "adrs/0030-models-per-entry-variant.adr.md"
  - "adrs/0031-variant-downstream-validation.adr.md"
  - "concepts/0008-agent-model-selection.concept.md"
  - "concepts/0009-agent-model-variant-parsing.concept.md"
  - "specifications/0005-multi-provider-model-setup.spec.md"
---

# Specification: Agent Model `:variant` Parsing

## Goal

Add support for `provider/model:variant` syntax in opencode agent model strings. When an agent specifies `codex/gpt-5.5:medium`, the system extracts `medium` as a thinking variant and maps it to the existing `variants` config structure (e.g., `reasoningEffort: "medium"`). The `:variant` suffix is optional, preserving backward compatibility.

### Use Case

Agent developer configures a sub-agent to use a thinking variant for a specific model:
```yaml
# agents/researcher.md
---
name: researcher
mode: subagent
model: codex/gpt-5.5:medium
models:
  - codex/gpt-5.5:medium
  - openrouter/claude:high
---
```

## Phases

### Phase 1 — Core Parser + Agent State + Models Array Variant (MODERATE)

- [x] `Provider.parseModel` — extend return type with `variant?: string`
- [x] `ModelV2.parse` — same extension for consistency
- [x] `Info.models` entry schema — add `variant?: string` to entry struct
- [x] Agent state construction — propagate `parsed.variant` for `model` field; store variant on each `models[]` entry
- [x] `resolveAgentModel` — return type includes `variant?: string` from matched entry
- [x] `parseModelSelection` (ACP) — prefer `:` variant over `/` fallback
- [x] `task.ts` caller — propagate variant from resolved model to session/prompt
- [x] Tests — variant test cases in provider.test.ts, agent-models.test.ts, resolve-agent-model.test.ts, parse-model-selection.test.ts, core models.test.ts

## Behaviors

| Scenario | Expected Result |
|----------|----------------|
| `codex/gpt-5.5:medium` | `{ providerID: "codex", modelID: "gpt-5.5", variant: "medium" }` |
| `codex/gpt-5.5` (no variant) | `{ providerID: "codex", modelID: "gpt-5.5", variant: undefined }` |
| `openrouter/anthropic/claude-3-opus:high` | `{ providerID: "openrouter", modelID: "anthropic/claude-3-opus", variant: "high" }` |
| `model: x:medium` + `variant: high` | Inline `:variant` wins (medium) |
| `models: [codex/gpt-5.5:medium]` selected | Resolved model carries `variant: "medium"` |
| `:invalid_variant` in model string | Passed through; validated downstream (falls to default) |

## Data Models

### `parseModel` Return Type
```typescript
type ParseModelResult = {
  providerID: ProviderID
  modelID: ModelID           // variant suffix stripped
  variant?: string           // NEW — extracted from :suffix
}
```

### Agent `Info.models` Entry Type
```typescript
Schema.Array(
  Schema.Struct({
    modelID: ModelID,
    providerID: ProviderID,
    variant: Schema.optional(Schema.String),  // NEW
  }),
)
```

### `resolveAgentModel` Return Type
```typescript
type ResolveAgentModelResult = {
  providerID: ProviderID
  modelID: ModelID
  variant?: string  // NEW — carried from matched models[] entry
}
```

## Implementation

| File | Change | Complexity |
|------|--------|------------|
| `provider/provider.ts:1890` | Extend `parseModel` return type | Low — pure function |
| `core/src/model.ts:108` | Extend `ModelV2.parse` return type | Low — pure function |
| `agent/agent.ts:46-55` | Add `variant?: string` to `Info.models` entry schema | Low |
| `agent/agent.ts:314-317` | Propagate parsed variant to `item.variant` + store on models entries | Medium |
| `agent/agent.ts:487` | Extend `resolveAgentModel` return type | Low |
| `acp/agent.ts:1877` | Prefer `:` variant over `/` fallback in `parseModelSelection` | Low |
| `tool/task.ts:195` | Consume variant from resolved model | Low |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `models[]` variant not propagated to session variant if caller misses update | Low | Medium | All callers of `resolveAgentModel` must handle resolved variant |
| Conflict between `:variant` and explicit `variant` field | Low | Medium | Documented precedence: models[] match > inline model > config > default |
| ACP `parseModelSelection` double-counts variant from `:` and `/` | Low | Medium | Check `parsed.variant` first; skip `/` fallback if already set |
| TypeScript strict mode complaint about extra return field | Low | Low | Structural typing — extra fields on return value don't cause errors |

## Milestones

- 2026-07-09: Implementation complete. Full test suite: 442 pass/0 fail opencode, 13 pass/0 fail core.

## Links

- [[adrs/0027-parse-model-variant-return-type.adr.md]] — Extend `parseModel` return type
- [[adrs/0028-inline-variant-precedence.adr.md]] — Inline variant over config variant
- [[adrs/0029-colon-as-variant-separator.adr.md]] — `:` as variant separator
- [[adrs/0030-models-per-entry-variant.adr.md]] — Per-entry variant for `models[]`
- [[adrs/0031-variant-downstream-validation.adr.md]] — Validate variant downstream
- [[concepts/0008-agent-model-selection.concept.md]] — Agent model selection
- [[concepts/0009-agent-model-variant-parsing.concept.md]] — Variant parsing concept

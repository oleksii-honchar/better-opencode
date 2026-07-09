---
type: concept
title: "Agent Model Variant Parsing (`:variant` Syntax)"
createdAt: "2026-07-09T10:30:00Z"
updatedAt: "2026-07-09T10:30:00Z"
tags: [agent, model-resolution, parsing, variant]
see_also:
  - "concepts/0008-agent-model-selection.concept.md"
  - "adrs/0027-parse-model-variant-return-type.adr.md"
  - "adrs/0028-inline-variant-precedence.adr.md"
  - "adrs/0029-colon-as-variant-separator.adr.md"
  - "adrs/0030-models-per-entry-variant.adr.md"
  - "adrs/0031-variant-downstream-validation.adr.md"
  - "specifications/0006-agent-model-variant-parsing.spec.md"
---

# Concept: Agent Model Variant Parsing (`:variant` Syntax)

## What

Agent model strings can include an optional `:variant` suffix to select a thinking variant for a model. For example, `codex/gpt-5.5:medium` selects the `medium` variant, which maps to `reasoningEffort: "medium"` in the model's `variants` config. The variant is optional — `codex/gpt-5.5` (no variant) continues to work unchanged.

## Why

Before this feature, the variant had to be set explicitly via the `variant:` config field on the agent. This was inconvenient when different models needed different variants. The `:variant` syntax allows the variant to be specified inline with the model string, making configuration more expressive and reducing the need for separate `variant:` declarations.

## Key Details

### Parser Syntax

`{provider}/{modelID}:{variant}` — e.g., `codex/gpt-5.5:medium`
- Split on first `/` → providerID / rest
- If rest contains `:`, extract everything after last `:` as variant
- `modelID` is everything before last `:` (or entire rest if no `:`)
- `:` is the unambiguous separator (model IDs cannot contain `:`)

### Supported Formats

| Input | providerID | modelID | variant |
|-------|-----------|---------|---------|
| `anthropic/claude-sonnet-4` | `anthropic` | `claude-sonnet-4` | undefined |
| `codex/gpt-5.5:medium` | `codex` | `gpt-5.5` | `"medium"` |
| `openrouter/anthropic/claude-3-opus:high` | `openrouter` | `anthropic/claude-3-opus` | `"high"` |

### Variant Precedence (highest to lowest)

1. Inline `:variant` from matched `models[]` entry
2. Inline `:variant` from `model` string
3. Explicit `variant` field in agent config
4. Previously set `item.variant` (from defaults or parent)

### Single Model Flow

```
model: "codex/gpt-5.5:medium"
  → parseModel → { providerID, modelID, variant: "medium" }
  → item.variant = "medium"  (stored on agent Info)
  → prompt({... variant: item.variant })
  → Session model.variant stored in DB
  → ProviderTransform applies variant options
```

### Multi-Model (`models[]`) Flow

```
models: ["codex/gpt-5.5:medium"]
  → parseModel per entry → entry has variant preserved
  → resolveAgentModel selects matching entry → returns entry with variant
  → resolvedModel.variant takes effect as effective variant
```

### Validation

`parseModel` is a pure string parser — it extracts the variant without validating it against available variants. Validation happens downstream in `ProviderTransform` and prompt resolution. Invalid variants silently fall through to default.

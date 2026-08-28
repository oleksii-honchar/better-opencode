---
type: concept
title: "Agent Model Selection from Frontmatter"
createdAt: "2026-07-06T13:15:00Z"
updatedAt: "2026-08-28T17:45:00Z"
tags: [agent, model-resolution, configuration]
see_also:
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "adrs/0023-resolution-priority.adr.md"
  - "adrs/0024-exact-provider-match.adr.md"
  - "adrs/0025-graceful-fallback.adr.md"
  - "adrs/0026-deprecate-model-fields.adr.md"
  - "adrs/0030-models-per-entry-variant.adr.md"
  - "adrs/0097-subagent-model-mirroring.adr.md"
  - "specifications/0005-multi-provider-model-setup.spec.md"
  - "concepts/0004-subagent-delegation.concept.md"
  - "concepts/0009-agent-model-variant-parsing.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Concept: Agent Model Selection from Frontmatter

## What

When a sub-agent is invoked via the Task tool, the system determines which LLM model to use by resolving the sub-agent's frontmatter fields against the parent agent's current provider. Three frontmatter fields participate in this resolution, evaluated in strict priority order.

## Why

Before the `models:` field, agents could only specify a single model (`model:`) or a suffix variant (`modelPreset:`). Neither supported multi-provider setups — an agent configured for mammoth would fail or use a wrong provider when invoked from a deepseek session. The resolution chain enables agents to automatically select the optimal model for whatever provider the parent session is using, without requiring per-provider agent definitions.

## Key Details

### The Three Fields

| Field | Type | Resolution Behavior |
|-------|------|-------------------|
| `models:` | `string[]` — array of `provider/modelID[:variant]` strings | Two-stage match against the parent: **(1)** exact `(providerID, modelID)` match mirroring the parent — inherits the parent's effective variant when present; **(2)** provider-only match — the first entry sharing the parent's `providerID` (legacy). If neither matches, fall through. |
| `model:` | `string` — single `provider/modelID` string | Return the explicitly specified model. **Deprecated** — use `models:` instead. |
| `modelPreset:` | `string` — suffix (e.g., `-precise`, `-fast`) | Compute `modelID = parentModel.modelID + modelPreset`, using `parentModel.providerID`. **Deprecated** — use `models:` instead. |

### Resolution Chain

```
Parent agent using: { providerID: "mammoth", modelID: "qwen3.6-40b" }

Sub-agent frontmatter:
  models:
    - mammoth/qwen3.6-40b
    - deepseek/deepseek-v4-flash
  model: codex/gpt-5          # deprecated fallback
  modelPreset: -precise       # deprecated fallback

Resolution:
  1. models: (two-stage match against the parent)
     a. exact (providerID, modelID) match → mammoth/qwen3.6-40b ✓
        (mirrors parent: both "mammoth" and "qwen3.6-40b" match)
        → RESULT: mammoth/qwen3.6-40b
        (on an exact match the parent's effective variant is inherited when present)
     b. (only if no exact match) provider-only match →
        first entry whose providerID is "mammoth" (legacy)

  (If step 1 had no match at all:)
  2. model: → codex/gpt-5 ✓
     → RESULT: codex/gpt-5

  (If both steps 1 and 2 missing:)
  3. modelPreset: → qwen3.6-40b-precise on mammoth
     → RESULT: mammoth/qwen3.6-40b-precise

  (If all three missing:)
  4. Parent model → mammoth/qwen3.6-40b
     → RESULT: mammoth/qwen3.6-40b (inheritance)
```

> **Two-stage in practice (the codex luna/terra case):** with `models:
> [codex/gpt-5.6-luna:high, codex/gpt-5.6-terra:high]` and a parent on
> `codex/gpt-5.6-terra:high`, stage 1a (exact providerID + modelID match) selects the
> `terra` entry and inherits variant `high` — not the first-listed `luna`. A provider-only
> match (stage 1b) would have picked `luna`, which was the previous behavior and the reported bug.

### Provider-Model String Format

Each `models:` entry is a `provider/modelID` string parsed by `Provider.parseModel()`:

```
{providerID}/{modelID}
```

Examples:
- `mammoth/qwen3.6-40b` → `{ providerID: "mammoth", modelID: "qwen3.6-40b" }`
- `deepseek/deepseek-v4-flash` → `{ providerID: "deepseek", modelID: "deepseek-v4-flash" }`
- `codex/gpt-5` → `{ providerID: "codex", modelID: "gpt-5" }`

> **Note:** Since July 2026, model strings also support an optional `:variant` suffix 
> (e.g., `codex/gpt-5.5:medium`). See [[concepts/0009-agent-model-variant-parsing.concept.md]].

### Data Flow

```
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   Task Tool  │───▶│  Agent Config    │───▶│  Model Resolution │
│   (parent    │    │   (models list)  │    │   (provider      │
│     model)   │    │   (model)        │    │    matching)      │
│              │    │   (modelPreset)  │    │                   │
└──────────────┘    └──────────────────┘    └────────┬──────────┘
     │                                                │
     │  providerID: "mammoth"                         ▼
     │  modelID: "qwen3.6-40b"              ┌──────────────────────────────┐
     └──────────────────────────────────────▶│   Resolution Priority:        │
                                             │   1. models list (match)     │
                                             │   2. explicit model          │
                                             │   3. modelPreset (suffix)    │
                                             │   4. parent model (inherit)  │
                                             └──────────────┬───────────────┘
                                                            │
                                                            ▼
                                                       ┌──────────────────┐
                                                       │ Resolved Model    │
                                                       │ providerID:       │
                                                       │   "mammoth"       │
                                                       │ modelID:          │
                                                       │   "qwen3.6-40b"   │
                                                       └──────────────────┘
```

### Matching Rules

- **Two-stage match** — the `models:` list is matched against the parent in two stages, in order:
  1. **Exact `(providerID, modelID)` match** — the first entry where **both** `providerID` and `modelID` equal the parent's (mirrors the parent's exact model). On this match, the resolved variant is the parent's effective variant when one is present; otherwise the entry's own variant is kept.
  2. **Provider-only match** — if no exact match exists, the first entry whose `providerID` equals the parent's (legacy behavior). The entry's own variant is kept here.
- **Exact comparison only** — both stages use `===` comparison. No fuzzy matching, prefix matching, or wildcards (ADR-0024).
- **Unmatched providers** — if neither stage matches, fall through to `model:`, then `modelPreset:`, then parent model. No error thrown.

### Schema Locations

| Layer | File | Field |
|-------|------|-------|
| Config (YAML) | `config/agent.ts` | `models: Schema.optional(Schema.Array(ConfigModelID))` |
| Parsed (runtime) | `agent/agent.ts` | `models: Array<{ modelID: ModelID, providerID: ProviderID }>` |
| Known keys | `config/agent.ts` | `"models"` in KNOWN_KEYS set |

### Deprecation Status

- `models:` — **Current** approach, no deprecation
- `model:` — **Deprecated** (ADR-0026), `@deprecated` annotation planned for Phase 6
- `modelPreset:` — **Deprecated** (ADR-0026), `@deprecated` annotation planned for Phase 6

Both deprecated fields remain functional as fallbacks in the resolution chain.

### Example: Complete Agent Frontmatter

```yaml
# agents/researcher.md
---
name: researcher
mode: subagent
description: Multi-provider capable research agent

# Provider-specific model selection (preferred)
models:
  - mammoth/qwen3.6-40b
  - deepseek/deepseek-v4-flash
  - codex/gpt-5

# Fallback when provider not in list (deprecated, but functional)
model: mammoth/qwen3.6-40b
---
```

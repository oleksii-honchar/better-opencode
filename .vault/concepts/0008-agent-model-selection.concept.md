---
type: concept
title: "Agent Model Selection from Frontmatter"
createdAt: "2026-07-06T13:15:00Z"
updatedAt: "2026-07-06T13:15:00Z"
tags: [agent, model-resolution, configuration]
see_also:
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "adrs/0023-resolution-priority.adr.md"
  - "adrs/0024-exact-provider-match.adr.md"
  - "adrs/0025-graceful-fallback.adr.md"
  - "adrs/0026-deprecate-model-fields.adr.md"
  - "specifications/0005-multi-provider-model-setup.spec.md"
  - "concepts/0004-subagent-delegation.concept.md"
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
| `models:` | `string[]` — array of `provider/modelID` strings | Iterate entries, match `providerID === parentModel.providerID` (exact match). First match wins. If no match, fall through. |
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
  1. models: → mammoth/qwen3.6-40b ✓ (parent provider "mammoth" matches)
     → RESULT: mammoth/qwen3.6-40b

  (If step 1 had no match:)
  2. model: → codex/gpt-5 ✓
     → RESULT: codex/gpt-5

  (If both steps 1 and 2 missing:)
  3. modelPreset: → qwen3.6-40b-precise on mammoth
     → RESULT: mammoth/qwen3.6-40b-precise

  (If all three missing:)
  4. Parent model → mammoth/qwen3.6-40b
     → RESULT: mammoth/qwen3.6-40b (inheritance)
```

### Provider-Model String Format

Each `models:` entry is a `provider/modelID` string parsed by `Provider.parseModel()`:

```
{providerID}/{modelID}
```

Examples:
- `mammoth/qwen3.6-40b` → `{ providerID: "mammoth", modelID: "qwen3.6-40b" }`
- `deepseek/deepseek-v4-flash` → `{ providerID: "deepseek", modelID: "deepseek-v4-flash" }`
- `codex/gpt-5` → `{ providerID: "codex", modelID: "gpt-5" }`

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

- **Exact match only** — `providerID === parentModel.providerID`. No fuzzy matching, prefix matching, or wildcards.
- **First match wins** — if multiple entries in `models:` have the same providerID, the first one is used.
- **Unmatched providers** — fall through to `model:`, then `modelPreset:`, then parent model. No error thrown.

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

# Multi-Provider Model Setup for Sub-Agents

**Feature:** Multi-Provider Model Setup (`models:`)  
**Status:** ✅ Implemented  
**Related ADRs:** ADR-0022 through ADR-0026 (in `.vault/adrs/`)  
**Concept:** Agent Model Selection from Frontmatter (`.vault/concepts/0008-agent-model-selection.concept.md`)

---

## Problem

The `model:` and `modelPreset:` fields support only a single model per agent or a suffix-based variant. When the parent session uses a different provider (e.g., deepseek vs mammoth), the sub-agent gets the wrong provider or fails. Agent developers must maintain separate agent files per provider.

**Example of the problem:**

```yaml
# Current approach — hardcoded to one provider
name: researcher
model: mammoth/qwen3.6-40b
---
```

If the parent session is running on deepseek, the researcher sub-agent would still try to use `mammoth/qwen3.6-40b` — wrong provider, potential failure.

## Solution

The `models:` field accepts an array of provider-prefixed model ID strings. When a sub-agent is invoked via the Task tool, the system resolves the parent agent's current provider and picks the corresponding model from the `models:` list.

```yaml
# New approach — provider-aware
name: researcher
models:
  - mammoth/qwen3.6-40b
  - deepseek/deepseek-v4-flash
  - codex/gpt-5
---
```

If the parent session is on mammoth → `mammoth/qwen3.6-40b`.  
If on deepseek → `deepseek/deepseek-v4-flash`.  
If on codex → `codex/gpt-5`.  
If on an unmatched provider → falls back to existing resolution chain.

## Resolution Chain

Strict priority order (first match wins):

1. **`models:` list** — iterate entries, match `providerID === parentModel.providerID` (exact match). If no match, fall through.
2. **`model:`** — return the explicitly specified model. **Deprecated** — use `models:` instead.
3. **`modelPreset:`** — compute `modelID = parentModel.modelID + modelPreset`, using `parentModel.providerID`. **Deprecated** — use `models:` instead.
4. **Parent model** — inheritance (no agent-level model field defined).

### Concrete Example

```
Parent agent using: { providerID: "deepseek", modelID: "deepseek-v4-flash" }

Sub-agent frontmatter:
  models:
    - mammoth/qwen3.6-40b
    - deepseek/deepseek-v4-flash
  model: codex/gpt-5          # deprecated fallback
  modelPreset: -precise       # deprecated fallback

Resolution:
  1. models: → deepseek/deepseek-v4-flash ✓ (parent provider "deepseek" matches)
     → RESULT: deepseek/deepseek-v4-flash
```

### Unmatched Provider Example

```
Parent agent using: { providerID: "puma", modelID: "qwen3.6-27b" }

Sub-agent frontmatter:
  models:
    - mammoth/qwen3.6-40b
    - deepseek/deepseek-v4-flash
  model: codex/gpt-5
  modelPreset: -precise

Resolution:
  1. models: → no entry with providerID "puma" — fall through
  2. model: → codex/gpt-5 ✓
     → RESULT: codex/gpt-5
```

## Provider-Model String Format

Each `models:` entry is a `{providerID}/{modelID}` string parsed by `Provider.parseModel()`:

| String | Parsed |
|--------|--------|
| `mammoth/qwen3.6-40b` | `{ providerID: "mammoth", modelID: "qwen3.6-40b" }` |
| `deepseek/deepseek-v4-flash` | `{ providerID: "deepseek", modelID: "deepseek-v4-flash" }` |
| `codex/gpt-5` | `{ providerID: "codex", modelID: "gpt-5" }` |

## Matching Rules

- **Exact match only** — `providerID === parentModel.providerID`. No fuzzy matching, prefix matching, or wildcards.
- **First match wins** — if multiple entries in `models:` have the same providerID, the first is used.
- **Unmatched providers** — fall through to `model:`, then `modelPreset:`, then parent model. No error thrown.

## Data Flow

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

## Schema Details

### Config Layer (YAML → Runtime)

**File:** `config/agent.ts`

```typescript
const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    // ... existing fields ...
    model: Schema.optional(ConfigModelID),          // deprecated
    models: Schema.optional(Schema.Array(ConfigModelID)),  // NEW
    modelPreset: Schema.optional(Schema.String),    // deprecated
    // ...
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)

const KNOWN_KEYS = new Set([
  // ... existing keys ...
  "model",
  "models",      // NEW: prevent absorption into options
  "modelPreset",
  // ...
])
```

### Parsed Layer (Runtime Object)

**File:** `agent/agent.ts`

```typescript
export const Info = Schema.Struct({
  // ... existing fields ...
  model: Schema.optional(Schema.Struct({ modelID: ModelID, providerID: ProviderID })),
  models: Schema.optional(
    Schema.Array(
      Schema.Struct({ modelID: ModelID, providerID: ProviderID })
    )
  ),  // NEW
  modelPreset: Schema.optional(Schema.String),
  // ...
})
```

**Config loading (parse step):**

```typescript
// After existing model parsing
if (value.model) item.model = Provider.parseModel(value.model)
if (value.models) item.models = value.models.map(Provider.parseModel)  // NEW
item.modelPreset = value.modelPreset ?? item.modelPreset
```

### Resolution Layer

**File:** `agent/agent.ts`

```typescript
export function resolveAgentModel(
  agentModels: Info["models"],    // NEW parameter
  agentModel: Info["model"],
  agentModelPreset: Info["modelPreset"],
  parentModel: { providerID: ProviderID; modelID: ModelID },
): { modelID: ModelID; providerID: ProviderID } {
  // NEW: Check models list for parent provider match
  if (agentModels) {
    const match = agentModels.find(
      model => model.providerID === parentModel.providerID
    )
    if (match) return match
  }
  // Existing resolution chain (unchanged)
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

### Task Tool Integration

**File:** `tool/task.ts`

```typescript
const parentModel = {
  modelID: msg.info.modelID,
  providerID: msg.info.providerID,
}
const resolvedModel = Agent.resolveAgentModel(
  next.models,      // NEW parameter
  next.model,
  next.modelPreset,
  parentModel
)
```

## Deprecation Plan

### Timeline

1. **Phase 6 (current)** — `models:` is implemented and stable. Add `@deprecated` annotations to `model` and `modelPreset` schema fields. Continue supporting old format.
2. **Next major version** — Remove old fields, emit error when used.
3. **Subsequent version** — Remove deprecation annotations.

### Migration Guide

| Old Format | New Format |
|------------|------------|
| `model: mammoth/qwen3.6-40b` | `models:\n  - mammoth/qwen3.6-40b` |
| `modelPreset: -precise` | `models:\n  - mammoth/qwen3.6-40b\n  - deepseek/deepseek-v4-flash` |

### Deprecation Annotations

```typescript
model: Schema.optional(ConfigModelID).annotate({
  deprecated: "Use 'models' array instead. See documentation for migration guide.",
}),
modelPreset: Schema.optional(Schema.String).annotate({
  deprecated: "Use 'models' array instead. See documentation for migration guide.",
}),
```

## Behavior Table

| Scenario | Setup | Expected Result |
|----------|-------|----------------|
| Provider match in `models` list | `models: [mammoth/qwen, deepseek/v4]`, parent: mammoth | mammoth/qwen |
| No provider match — fallback | `models: [mammoth/qwen]`, parent: deepseek | Falls to `model:` / `modelPreset` / parent |
| `models` takes precedence over `model` | `models: [mammoth/qwen]`, `model: codex/gpt5`, parent: mammoth | mammoth/qwen (not codex/gpt5) |
| Empty `models` list | `models: []`, parent: mammoth | Falls to `model:` / `modelPreset` / parent |
| `models` undefined | No `models` field, parent: mammoth | Falls to `model:` / `modelPreset` / parent |

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Breaking change to `resolveAgentModel` callers | MEDIUM | Only one caller (task.ts) — single point of modification |
| Deprecation migration issues | MEDIUM | Clear migration guide, maintain compatibility period |
| Invalid provider/model strings | LOW | Parsing errors handled by existing `Provider.parseModel` |
| Backward compatibility loss | LOW | `models` field is optional, existing resolution chain preserved |

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `config/agent.ts` | Added `models` field to AgentSchema + KNOWN_KEYS | 5 |
| `agent/agent.ts` | Added `models` to Info schema, config parsing, extended `resolveAgentModel` | 28 |
| `tool/task.ts` | Pass `next.models` to `resolveAgentModel` | 2 |

## Test Coverage

| Test File | Pass | Fail |
|-----------|------|------|
| resolve-agent-model.test.ts | 14 | 0 |
| agent-models.test.ts | 3 | 0 |
| config/agent-models.test.ts | 4 | 0 |
| task.test.ts (models) | 2 | 0 |
| task.test.ts (full suite) | 17 | 0 |
| **TOTAL** | **40** | **0** |

## Open Decisions

1. **Unmatched provider fallback** — Falls through to `model:` / `modelPreset:` / parent model (not hard error).
2. **Catch-all entry** — No wildcard support in v1 (e.g., `*/qwen`); may be added in future if requested.
3. **First entry as default** — No; list order has no significance for fallback behavior.

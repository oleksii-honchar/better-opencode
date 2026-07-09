# Agent Model `:variant` Parsing (Spec 16)

## Overview

Add support for `provider/model:variant` syntax in opencode agent model strings. When an agent specifies `codex/gpt-5.5:medium`, the system extracts `medium` as a thinking variant and maps it to the existing `variants` config structure (e.g., `reasoningEffort: "medium"`). The `:variant` suffix is optional — backward compatible.

## Architecture

### Parser

`Provider.parseModel` (provider.ts:1890) is extended to return `variant?: string`:

```typescript
export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  const modelStr = rest.join("/")
  const colonIdx = modelStr.lastIndexOf(":")
  const modelID = colonIdx >= 0 ? modelStr.slice(0, colonIdx) : modelStr
  const variant = colonIdx >= 0 ? modelStr.slice(colonIdx + 1) : undefined
  return {
    providerID: ProviderID.make(providerID),
    modelID: ModelID.make(modelID),
    variant,
  }
}
```

### Variant Propagation

**Single model flow:**
```
model: "codex/gpt-5.5:medium"
  → parseModel → { providerID, modelID, variant: "medium" }
  → item.variant = "medium"  (stored on agent Info)
  → prompt({... variant: item.variant })
  → Session model.variant stored in DB
  → ProviderTransform applies variant options (reasoningEffort, etc.)
```

**Multi-model flow:**
```
models: ["codex/gpt-5.5:medium"]
  → parseModel per entry → entry has variant preserved
  → resolveAgentModel selects matching entry → returns entry with variant
  → resolvedModel.variant takes effect as effective variant
```

### Precedence

1. Inline `:variant` from matched `models[]` entry
2. Inline `:variant` from `model` string
3. Explicit `variant` field in agent config
4. Previously set `item.variant` (defaults, parent override, inheritance)

### Variant Separator

`:` is used as the variant separator (not `/`) because model IDs can contain `/` (e.g., `openrouter/anthropic/claude-3-opus`), making `/` ambiguous as a delimiter. The ACP's existing `/`-based variant extraction continues to work as a fallback in `parseModelSelection`.

### Validation

`parseModel` is a pure string parser — no validation. Variant validation happens downstream in `ProviderTransform` and prompt resolution. Invalid variants silently fall through to default.

## Files Changed

| File | Change |
|------|--------|
| `provider/provider.ts:1890` | Extend `parseModel` return type |
| `core/src/model.ts:108` | Extend `ModelV2.parse` return type |
| `agent/agent.ts:46-55` | Add `variant?: string` to `Info.models` entry schema |
| `agent/agent.ts:314-317` | Propagate variant to `item.variant` + store on `models[]` entries |
| `agent/agent.ts:487` | Extend `resolveAgentModel` return type |
| `acp/agent.ts:1877` | Prefer `:` variant over `/` fallback |
| `tool/task.ts:195` | Consume variant from resolved model |

## Test Coverage

All 140 agent-model related tests pass across:
- `provider.test.ts` — 8 parseModel tests
- `agent-models.test.ts` — 5 config tests
- `resolve-agent-model.test.ts` — 5 propagation tests
- `parse-model-selection.test.ts` — 6 tests
- `core models.test.ts` — 5 tests

Full suite: 442 tests pass (opencode) + 13 tests pass (core) — 0 failures.

## Related ADRs

- ADR-0027: Extend `parseModel` return type
- ADR-0028: Inline variant wins over explicit config variant
- ADR-0029: Use `:` as variant separator (not `/`)
- ADR-0030: Propagate per-entry variant for `models[]` array
- ADR-0031: Validate variant downstream, not in parser

---
type: adr
id: ADR-0026
title: "Deprecate model: and modelPreset: After models: Implementation"
status: accepted
createdAt: "2026-07-06T13:15:00Z"
updatedAt: "2026-07-06T13:15:00Z"
tags: [agent, model-resolution, deprecation]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "specifications/0005-multi-provider-model-setup.spec.md"
---

# ADR-0026: Deprecate model: and modelPreset: After models: Implementation

## Context

The `models:` field provides more comprehensive provider-specific model selection capabilities than `model:` and `modelPreset:` combined. Maintaining all three options increases complexity.

## Decision

Deprecate `model:` and `modelPreset:` fields after `models:` is implemented and stable. Use `@deprecated` annotations in schema definitions.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Keep all fields | Zero breaking change | Maintains complexity indefinitely | `models:` subsumes all functionality |
| Remove `model:` only | Simpler than all three | Inconsistent; partial solution | Misses opportunity to fully simplify |
| Remove `modelPreset:` only | Keeps simple single-model case | `modelPreset:` is a narrow pattern | `models:` handles this with one entry |

## Consequences

- **Positive:** Cleaner configuration schema; less maintenance burden; single, well-documented approach; future-proof for `models:` extensions
- **Negative:** Breaking change for existing agents; requires migration effort; needs clear migration guide
- **Neutral:** `models:` already exists as a fallback-compatible field during deprecation period

### Migration Guide

| Old Format | New Format |
|------------|------------|
| `model: mammoth/qwen3.6-40b` | `models:\n  - mammoth/qwen3.6-40b` |
| `modelPreset: -precise` | `models:\n  - mammoth/qwen3.6-40b\n  - deepseek/deepseek-v4-flash` |

### Deprecation Timeline

1. **Phase 6** — Add `@deprecated` annotations, continue supporting old format
2. **Next major version** — Remove old fields, emit error when used
3. **Subsequent version** — Remove deprecation annotations

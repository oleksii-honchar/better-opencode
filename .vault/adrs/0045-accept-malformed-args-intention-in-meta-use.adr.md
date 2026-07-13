---
type: adr
id: ADR-0045
title: "Accept Malformed Args and Optional Intention in meta_use"
createdAt: "2026-07-11T17:55:00Z"
updatedAt: "2026-07-12T18:45:00Z"
status: accepted
tags: [tool-calling, split-model, meta_use, interface]
see_also:
  - "[[0042-intent-delegation-architecture.adr.md]]"
  - "[[0007-meta-use-octocode-absolute-paths.spec.md]]"
  - "[[0032-protect-anthropic-protocol-tool-use.adr.md]]"
---

# Accept Malformed Args and Optional Intention in meta_use

## Context

The main model (Qwen3.6-27b) often fails to compose correct JSON arguments. If meta_use requires valid JSON, the main model's imperfect attempts will fail before even reaching the small model.

## Decision

**meta_use accepts args in any form (valid JSON, malformed JSON string, or raw text), plus an optional natural-language `intention` parameter:**

```typescript
interface MetaUseParams {
  toolName: string
  args: string | Record<string, any>  // any form — small model handles it all
  intention?: string                   // optional natural-language hint
}
```

The split router passes whatever it receives to the small model, which interprets and corrects it. The `intention` field gives the small model additional context when the main model can describe what it wants in plain language.

## Alternatives Considered

1. **Strict JSON validation before split router** — rejected (rejects main model's imperfect attempts)
2. **Only `intention`, no `args`** — rejected (args often contains useful partial data)
3. **Both optional** — rejected (args is required by the tool, must be present in some form)

## Consequences

**Positive:**
- Main model's imperfect JSON never fails early
- `intention` gives small model additional context for correction
- Small model is the sole authority on argument correctness

**Negative:**
- meta_use handler must handle string args gracefully
- Main model may not always provide `intention` (optional)

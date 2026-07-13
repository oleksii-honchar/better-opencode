---
type: adr
id: ADR-0044
title: "Execute Original Intent on Failure"
createdAt: "2026-07-11T17:55:00Z"
updatedAt: "2026-07-12T18:45:00Z"
status: accepted
tags: [tool-calling, split-model, error-handling, fallback]
see_also:
  - "[[0042-intent-delegation-architecture.adr.md]]"
  - "[[0004-unstuck-loop-detection.spec.md]]"
---

# Execute Original Intent on Failure

## Context

Split router can fail (timeout, network, small model crash).

## Decision

**Fallback: Execute with original intent**

```
meta_use({name, args})
  → split router → timeout
  → log.warn("split failed, using original intent")
  → tool.execute(original_args)
  → result
```

## Alternatives Considered

1. Return error to model — rejected (too disruptive)
2. Retry composition — rejected (compounds latency)

## Consequences

**Positive:** Tool calls never blocked, system continues functioning
**Negative:** May still have wrong args if composition fails

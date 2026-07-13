---
type: adr
id: ADR-0046
title: "Two-Phase Implementation Strategy"
createdAt: "2026-07-11T17:55:00Z"
updatedAt: "2026-07-12T18:45:00Z"
status: accepted
tags: [tool-calling, split-model, implementation, phase-1, phase-2]
see_also:
  - "[[0042-intent-delegation-architecture.adr.md]]"
---

# Two-Phase Implementation Strategy

## Context

Tool-calling split model can be implemented at two levels of integration depth:
- **Phase 1:** Meta-use interception in agent-meta-tool (zero opencode changes)
- **Phase 2:** Better-opencode core changes via streamText() modification

## Decision

**Execute Phase 1 first, then evaluate before Phase 2:**

```
Phase 1 (Immediate)                              Phase 2 (Conditional)
─────────────────────                            ───────────────────────
• Small model deployment                       • Modify better-opencode streamText()
• Split router in agent-meta-tool              • Intercept ALL tool calls (meta_use + built-in)
• Meta_use interception                       • Rebuild and reinstall better-opencode
• Zero opencode changes                        • Full coverage including built-in tools
• Deploy today                                • Requires upstream merge or fork change
                                                 • Higher risk, more effort
```

**Phase Transition Decision Point:**
- After Phase 1 completion and validation
- Documented evaluation of whether Phase 1 is sufficient
- Proceed to Phase 2 only if Phase 1 leaves gaps

## Alternatives Considered

1. **Phase 2 first** — rejected (requires opencode changes, blocks Phase 1 benefits)
2. **Both phases simultaneously** — rejected (increases risk, harder to isolate issues)
3. **Only Phase 2** — rejected (bypasses quick win of Phase 1)

## Consequences

**Positive:**
- Phase 1 provides immediate value (can deploy today)
- Low risk, fully reversible
- Clear validation point before committing to opencode changes
- Phase 2 optional — not all workloads need it

**Negative:**
- Phase 1 may not cover all tool calls (only meta_use)
- If Phase 2 needed later, may require architectural adjustments
- Two deployment windows instead of one

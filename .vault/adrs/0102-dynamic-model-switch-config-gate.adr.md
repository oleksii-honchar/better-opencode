---
type: adr
id: ADR-0102
title: "`dynamicModelSwitch` Root Config Gate — Default On (Opt-Out)"
status: accepted
createdAt: "2026-09-01T15:48:45Z"
updatedAt: "2026-09-01T15:48:45Z"
tags: [configuration, model-resolution, cost-control]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0100-in-flight-model-switch-tool.adr.md"
  - "adrs/0101-provider-scoped-smart-models.adr.md"
  - "specifications/0020-in-flight-model-switching.spec.md"
---

# ADR-0102: `dynamicModelSwitch` Root Config Gate — Default On (Opt-Out)

## Context

In-flight model switching ([[adrs/0100-in-flight-model-switch-tool.adr.md]]) has cost/runaway
risk (an LLM could repeatedly switch to a pricier model). It must be controllable. The user
explicitly requested the feature be **on by default**, controlled by a root config key named
`dynamicModelSwitch`.

## Decision

Add an optional root-level field to `Config.Info` (`config/config.ts`):

```ts
dynamicModelSwitch: Schema.optional(Schema.Struct({
  enabled: Schema.optional(Schema.Boolean)   // read as `?.enabled ?? true` → default ON
}))
```

Read as `cfg.dynamicModelSwitch?.enabled ?? true` at both read sites (tool registration in
`tool/registry.ts` and prompt injection in `session/system.ts` / call site `session/prompt.ts`).
The **cost/blast-radius concern** that motivated an earlier opt-in default is addressed by
**provider-scoped `smartModels`** (ADR-0101): the agent can only switch to user-curated models,
so there is no open-ended catalog surface. An agent with no `smartModels` is effectively a no-op.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Always-on, no gate | Zero config | No way to disable | Rejected |
| Default-on (opt-out) | Works out of the box | Unaware users may see switches | **Chosen** (user decision) |
| Default-off (opt-in) | Conservative | Feature dead unless configured | Superseded by user's explicit request |
| Hard limits (max switches / direction locks) | Bounded runaway | More code/config for a mostly behavioral risk | Revisit with usage data |

## Consequences

- **Positive:** Works out of the box; one line to disable (`dynamicModelSwitch: { enabled: false }`).
- **Positive:** Root-level key matches opencode config patterns and #8456's config-driven proposal.
- **Trade-off:** Users unaware of the feature could see their agent switch models — mitigated by provider-scoping (ADR-0101) and the visible `ModelSwitched` TUI banner.

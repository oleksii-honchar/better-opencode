---
type: specification
title: "Multi-Provider Model Setup for Sub-Agents"
kind: feature
status: completed
createdAt: "2026-07-06T13:15:00Z"
updatedAt: "2026-07-06T13:15:00Z"
tags: [agent, model-resolution, configuration]
owner: ""
target: null
see_also:
  - "adrs/0022-multi-provider-model-field.adr.md"
  - "adrs/0023-resolution-priority.adr.md"
  - "adrs/0026-deprecate-model-fields.adr.md"
  - "concepts/0008-agent-model-selection.concept.md"
---

# Specification: Multi-Provider Model Setup for Sub-Agents

## Goal

Enable per-provider model selection for sub-agents. Each agent can define a `models:` list with provider-prefixed model IDs. When a sub-agent is invoked, the system resolves the parent agent's current provider and picks the corresponding model. Falls back to existing resolution chain when no match.

### Use Case

Agent developer configures a sub-agent to automatically select the optimal model for whatever provider the parent session is using:

```yaml
# agents/researcher.md
---
mode: subagent
models:
  - mammoth/qwen3.6-40b
  - deepseek/deepseek-v4-flash
  - codex/gpt-5
---
```

## Phases

### Phase 1 — Configuration Schema

- [x] Add `models: Schema.optional(Schema.Array(ConfigModelID))` to AgentSchema in `config/agent.ts`
- [x] Add `"models"` to KNOWN_KEYS set in `config/agent.ts`

### Phase 2 — Info Schema & Config Loading

- [x] Add `models` field to Info schema in `agent/agent.ts`
- [x] Parse `models` via `Provider.parseModel` during config loading

### Phase 3 — Resolution Logic

- [x] Extend `resolveAgentModel` to accept `agentModels` parameter
- [x] Add `models` resolution: find entry matching `parentModel.providerID`
- [x] Maintain existing fallback chain: `model:` → `modelPreset:` → parent

### Phase 4 — Task Tool Integration

- [x] Pass `next.models` to `resolveAgentModel` in `tool/task.ts`

### Phase 5 — Test Coverage

- [x] 40 tests across 4 files, all passing (resolve-agent-model.test.ts, agent-models.test.ts, config/agent-models.test.ts, task.test.ts)

### Phase 6 — Deprecation

- [ ] Add `@deprecated` annotations to `model` and `modelPreset` fields (future)

## Behaviors

| Scenario | Expected Result |
|----------|----------------|
| Provider match in `models` list | Returns matching `{ providerID, modelID }` |
| No provider match — fallback | Falls through to `model:` / `modelPreset:` / parent model |
| `models` takes precedence over `model` | `models:` wins when provider matches |
| Empty `models` list | Falls through to `model:` / `modelPreset:` / parent model |
| `models` undefined | Falls through to `model:` / `modelPreset:` / parent model |

## Risks

- **Breaking change to `resolveAgentModel` callers:** MEDIUM — Only one caller (task.ts) — single point of modification
- **Deprecation migration issues:** MEDIUM — Provide clear migration guide, maintain compatibility period
- **Invalid provider/model strings:** LOW — Parsing errors handled by existing Provider.parseModel
- **Backward compatibility loss:** LOW — `models` field is optional, existing resolution chain preserved

## Milestones

- 2026-07-06: Implementation complete, reviewed, all 40 tests passing

## Links

- [[adrs/0022-multi-provider-model-field.adr.md]] — Decision to add `models:` field
- [[adrs/0023-resolution-priority.adr.md]] — Resolution priority chain
- [[adrs/0024-exact-provider-match.adr.md]] — Exact provider matching
- [[adrs/0025-graceful-fallback.adr.md]] — Graceful fallback behavior
- [[adrs/0026-deprecate-model-fields.adr.md]] — Deprecation plan for `model:` and `modelPreset:`

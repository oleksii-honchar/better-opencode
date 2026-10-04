---
type: memory
title: "LiteLLM opencode Key Is DB-Backed — Caps via /key/update, Not config.yaml"
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [litellm, config, gotcha, ops]
system: shared
see_also:
  - "../runbooks/0004-token-budget-caps-and-runaway-alerting.runbook.md"
---

# Memory: LiteLLM Virtual Key `opencode` Lives in the Database

## Fact

The `opencode` LiteLLM key has no `config.yaml` section
(`general_settings.database_url` + `store_model_in_db: true`); per-key caps
(`max_budget`, `rpm_limit`, `tpm_limit`) must be set via `/key/update` or the
Admin UI — effective immediately, no container restart.

## Context

A 2026-10-03 task premise assumed config.yaml editing; verified false (the file
has no key section).

## Impact

Any future key-cap work on lite-llm.lan must use the API path (runbook 0004);
editing config.yaml for caps silently does nothing.

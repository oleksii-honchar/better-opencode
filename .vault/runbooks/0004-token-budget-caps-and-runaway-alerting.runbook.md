---
type: runbook
title: "Token Budget Caps, Runaway Alerting, Telemetry Verification, Idle-Session Policy"
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [litellm, openrouter, alerting, clickstack, otel, sessions, ops]
system: shared
see_also:
  - "../adrs/0112-telemetry-visibility-startup-warn.adr.md"
  - "../memories/0027-litellm-streaming-spans-empty-usage-object.memory.md"
  - "../memories/0028-litellm-db-backed-keys-caps-via-key-update.memory.md"
  - "../specifications/0024-runaway-loop-hardening.spec.md"
---

# Runbook: Token Budget Caps, Runaway Alerting & Idle-Session Policy

> Origin: 2026-10-03 runaway-loop incident (163.7M tokens, $65.02 in 5.6 h).
> Items marked **[USER ACTION]** require credentials/remote access.

## Prerequisites

- LiteLLM master key via Infisical path `/lite-llm` (`LITELLM_MASTER_KEY`)
- ClickStack `otel_traces` access (`ssh 192.168.1.188` → `docker exec clickstack-ch-server clickhouse-client`)
- HyperDX API key (`HYPERDX_API_KEY`)

## Steps

### 1. LiteLLM `opencode` key caps (max_budget / rpm / tpm)

The `opencode` key is **DB-backed** (`store_model_in_db: true`) — caps go through
`/key/update` or the Admin UI, NOT `config.yaml` (see memory 0028). Effective
immediately, no container restart.

```bash
infisical run --env=prod --path=/lite-llm -- \
  curl -s -X POST "https://lite-llm.lan/key/update" \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
    -H "Content-Type: application/json" \
    -d '{"key": "sk-GbrdFlA8SUmhCHkKQdQWDg", "max_budget": 20, "budget_duration": "24h", "rpm_limit": 300, "tpm_limit": 100000}'
```

Sizing rationale: $20/24h (incident burned $65.02 in 5.6 h); 300 rpm (incident
sustained ~10 req/min, 30× headroom); 100K tpm ≈ 6M tokens/hr ceiling (incident
ran ~29M tokens/hr; healthy sessions ≲ 2M/hr).

Admin UI alternative: `https://lite-llm.lan` → Virtual Keys → alias `opencode` →
Edit Settings.

### 2. OpenRouter account daily hard limit **[USER ACTION]**

OpenRouter → Settings → Keys → set the `OPENROUTER_API_KEY` usage limit to a
**daily hard cap ($25/day** — slightly above the LiteLLM cap so the gateway trips
first and stays the canary). Optionally enable credit-alert e-mail.

### 3. ClickStack alert: >2M tokens/hr per session

```sql
SELECT
    SpanAttributes['session.id'] AS session_id,
    toStartOfHour(Timestamp)     AS hour,
    sum(toUInt64OrZero(SpanAttributes['llm.token_count.total'])) AS tokens_per_hour
FROM otel_traces
WHERE SpanName = 'opencode.llm'
  AND has(SpanAttributes, 'session.id')
  AND Timestamp >= now() - INTERVAL 1 HOUR
GROUP BY session_id, hour
HAVING tokens_per_hour > 2000000
```

Create in HyperDX (`https://hyper-dx.lan` → Alerts, source Traces
`6a00add08098b0cff44c91df`): sum `llm.token_count.total`, groupBy
`session.id`, window 1 h, every 5 min, condition > 2,000,000. Gateway-side
complement on `litellm_request` is blocked until `usage_object` is populated
(memory 0027, workstream D3).

### 4. Telemetry verification (after any env change)

Fast (v2 REST): query HyperDX `/api/v2/charts/series` with
`where: "SpanAttributes.session.id:<SESSION_ID>"` — expect `opencode.*` spans
within ~2 min. Raw: `SELECT count(*) FROM otel_traces WHERE
SpanAttributes['session.id']='<id>'`. Proven end-to-end 2026-10-03 (marker span
`task5-otel-env-verify`, traceId `55e47e0a6b9e22962b7fab618d0c6dcd`, ~15 s).

### 5. Idle-session archive policy (weekly)

Sessions idle >7 days move out of the active tree into `~/.agent-sessions/archive/`
(keeping the `YY/MM/DD` layout):

```bash
find ~/.agent-sessions/26 -mindepth 3 -maxdepth 3 -type d -mtime +7
# then: mkdir -p ~/.agent-sessions/archive/<YY/MM/DD> && mv <dir> ...
```

Rationale: the incident session sat idle 4 days and was silently resumed into a
163.7M-token doom-loop.

## Verification

- `/key/info?key=...` shows the caps; `ExceededTokenBudget`/429 once exceeded.
- HyperDX alert fires on a synthetic >2M/hr window (incident shape fires ~14×).
- New opencode session appears in `otel_traces` within 2 min.

## Rollback

- Caps: `/key/update` with `"max_budget": null` etc., or Admin UI.
- OTel env: `launchctl bootout gui/$(id -u)/com.bensyne.otel-env`; remove the
  `~/.zshrc` export (backup: `~/.zshrc.bak-261003`).

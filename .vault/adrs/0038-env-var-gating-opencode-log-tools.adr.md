---
type: adr
id: ADR-0038
title: "Environment Variable Gating — OPENCODE_LOG_TOOLS"
status: accepted
createdAt: "2026-07-12T19:47:00Z"
updatedAt: "2026-07-12T19:47:00Z"
tags: [logging, security]
supersedes: []
superseded_by: []
see_also: ["adrs/0035-json-lines-format-for-tools-log.adr.md"]
---

# ADR-0038: Environment Variable Gating — OPENCODE_LOG_TOOLS

## Context

Logging full tool args and outputs has privacy and performance implications. It must be opt-in.

## Decision

- Env var: `OPENCODE_LOG_TOOLS=1` enables logging.
- Any other value or absence disables it.
- Checked once at module load: `const TOOLS_LOG_ENABLED = process.env.OPENCODE_LOG_TOOLS === "1"`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Config file flag | Persistent without env var | Requires config parsing before log init | Rejected — adds complexity, bootstrapping chicken/egg |
| Per-service log level | Flexible | Existing logger has no per-service file splitting | Rejected — would require new per-service routing |

## Consequences

- **Positive:** Follows existing `OPENCODE_*` env var conventions.
- **Positive:** No per-call overhead when disabled (write function is a no-op).
- **Positive:** Runtime toggle — users can enable without recompiling.
- **Negative:** Changing the env var requires a process restart to take effect.
- **Risk:** Sensitive data exposure if enabled unintentionally — documentation must prominently warn.

---
type: index
title: "Atomic Memories"
createdAt: "2026-06-08T18:32:00Z"
updatedAt: "2026-08-30T15:54:00Z"
tags: []
---

# Atomic Memories

Self-contained facts, gotchas, incident learnings, and one-off knowledge that doesn't belong in ADRs or concepts.

## Nodes

- [[0001-part-table-dominance.memory.md]] — Part Table Is 91% of OpenCode SQLite Database
- [[0002-no-automated-db-maintenance.memory.md]] — OpenCode Database Had No Automated Maintenance Before DB Cleanup Feature
- [[0003-system-prompt-cache-invalidation.memory.md]] — system.transform hook invalidates Anthropic cache for plugin authors
- [[0004-dev-db-channel-path.memory.md]] — Dev Mode Database Path Depends on InstallationChannel (opencode-local.db vs opencode.db)
- [[0005-mcp-absolute-directory-argument-gotcha.memory.md]] — MCP Absolute Directory Arguments Can Be Mistaken for Attachment Files
- [[0006-sessionid-schema-prefix-gotcha.memory.md]] — SessionID Schema Requires "ses" Prefix — Synthetic IDs Fail
- [[0007-no-agent-events.memory.md]] — No Agent-to-Agent Communication Events on the Bus
- [[0008-forked-effect-hang-race-gotcha.memory.md]] — Forked Dynamic Skill Scan Hung and Raced (Fixed by Going Synchronous)
- [[0009-doom-loop-fingerprint-fnv1a.memory.md]] — Doom Loop Input Fingerprint Uses fnv1a, Not sha256
- [[0010-doom-loop-missing-input-run.memory.md]] — Missing-Input Call Does Not Reset Doom Loop Run
- [[0011-unstuck-test-default-drift.memory.md]] — Unstuck Tests Drift from Defaults (xml guard; selfDiagnosis drift resolved by ADR-0073)
- [[0012-cross-session-injection-bleed.memory.md]] — Cross-Session Injection Bleed — registerDynamic is Process-Wide
- [[0013-scan-cache-empty-poison.memory.md]] — scanCache Poisoned Empty — Timestamp Never Read
- [[0014-env-marker-persona-boundary.memory.md]] — Env-Block Marker "You are powered by the model named" is the Deterministic Persona Boundary
- [[0015-cross-stream-detection-gap.memory.md]] — Cross-Stream Doom-Loop Detection Gap (Per-Stream Isolation)
- [[0016-self-diagnosis-regex-gap.memory.md]] — Self-Diagnosis Regex Gap — 'Stuck on X' Pattern Not Detected
- [[0017-prune-looping-messages-orphan.memory.md]] — pruneLoopingMessages Creates Orphaned Tool-Results
- [[0018-unstuck-trim-bug-root-cause.memory.md]] — Commit 04c1e08c78 Extended Pruning to Tool-Result Messages
- [[0019-subagent-abrupt-stop-workaround.memory.md]] — Sub-Agent Abrupt Stop — Workaround: Retry or Raise Output Token Max
- [[0020-mcp-remote-0201-signin-bugs.memory.md]] — mcp-remote 0.2.0/0.2.1 Have Sign-In Coordination Bugs — Pin >= 0.2.6
- [[0021-ibkr-mcp-endpoint-behavior.memory.md]] — IBKR MCP Endpoint Behavior — 401 Empty Body, Akamai no-store, Registration Works
- [[0022-remote-type-nul-byte-workaround.memory.md]] — type: remote MCP Servers Break (NUL byte) — Use local mcp-remote Bridges
- [[0023-litellm-mcp-tool-name-prefixing.memory.md]] — LiteLLM-Proxy MCP Tool Names Get <server>- Prefix; Unprefixed Allowlists Silently Break

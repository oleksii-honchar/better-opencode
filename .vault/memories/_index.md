---
type: index
title: "Atomic Memories"
createdAt: "2026-06-08T18:32:00Z"
updatedAt: "2026-08-10T18:45:00Z"
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

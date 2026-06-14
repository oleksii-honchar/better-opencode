---
type: index
title: "Architecture Decision Records"
createdAt: "2026-06-08T18:32:00Z"
updatedAt: "2026-06-14T13:10:00Z"
tags: []
---

# Architecture Decision Records

Decisions about how better-opencode is built, configured, and maintained — captured as ADRs with context, alternatives, and consequences.

## Nodes

- [[0001-system-prompt-persistence.adr.md]] — Persist System Prompt in Session Database (ADR-0001, status: proposed)
- [[0002-hybrid-cli-background.adr.md]] — Hybrid Approach for DB Maintenance (ADR-0002, status: accepted)
- [[0003-existing-time-archived-cascade.adr.md]] — Use Existing time_archived + Cascade Deletion (ADR-0003, status: accepted)
- [[0004-wal-checkpoint-truncate.adr.md]] — Background WAL Checkpoint — TRUNCATE Mode (ADR-0004, status: accepted)
- [[0005-journal-size-limit.adr.md]] — PRAGMA journal_size_limit Instead of auto_vacuum (ADR-0005, status: accepted)
- [[0006-tool-output-age-deletion.adr.md]] — Tool Output Deletion on Age, Not Session Status (ADR-0006, status: accepted)
- [[0007-always-extract-skills.adr.md]] — metaSkillEnabled: Always Extract Skills to MetaState (ADR-0007, status: accepted)
- [[0008-leave-tools-transform-unchanged.adr.md]] — metaSkillEnabled: Leave toolsTransform Unchanged (ADR-0008, status: accepted)

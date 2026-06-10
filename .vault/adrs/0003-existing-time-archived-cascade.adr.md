---
type: adr
id: ADR-0003
title: "Use Existing time_archived + Cascade Deletion for Session Cleanup"
status: accepted
createdAt: "2026-06-10T14:30:00Z"
updatedAt: "2026-06-10T14:30:00Z"
tags: [database, session-management, schema]
see_also:
  - "adrs/0002-hybrid-cli-background.adr.md"
  - "adrs/0006-tool-output-age-deletion.adr.md"
  - "concepts/0001-session-model.concept.md"
  - "specifications/0001-opencode-db-cleanup.spec.md"
---

# ADR-0003: Use Existing time_archived + Cascade Deletion for Session Cleanup

## Context

Sessions need to be cleaned up automatically. Options: (a) write raw DELETE SQL, (b) use Drizzle ORM cascades, (c) manual message/part deletion per session.

## Decision

Use the existing `time_archived` column + Drizzle ORM cascade FK deletions.

## Rationale

- `time_archived`, `setArchived`, and `remove(sessionID)` already exist in the codebase
- Drizzle schema has `onDelete: cascade` from session → message → part — one `DELETE FROM session` cascades cleanly
- No schema migration needed
- `listGlobal()` already filters archived sessions from default views

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Raw DELETE SQL | Explicit control | Bypasses ORM patterns; no cascade awareness | Unnecessary — cascade already works |
| Manual message/part deletion | Fine-grained control | Error-prone, verbose, no cascade | Cascade is cleaner |

## Consequences

- **Positive:** Zero new schema surface, reuses battle-tested code
- **Positive:** Archive-then-delete two-phase pattern gives safety buffer
- **Negative:** Cascade delete is implicit — must be documented for future maintainers

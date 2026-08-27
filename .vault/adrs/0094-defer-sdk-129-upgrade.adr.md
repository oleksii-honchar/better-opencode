---
type: adr
id: ADR-0094
title: "Defer MCP SDK 1.29.0 Upgrade"
status: accepted
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [mcp, sdk, dependency, oauth]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0092-guard-oauth-http-parsing.adr.md"
---

# ADR-0094: Defer MCP SDK 1.29.0 Upgrade

## Context

Findings verified 1.29.0's `auth.js` has the SAME unguarded `.json()` calls; the upgrade does not fix the crash. The fork is pinned to 1.27.1; upstream uses 1.29.0.

## Decision

Defer the SDK upgrade. Not required for any success criterion. If pursued later, do it as a separate change after the guarded fetchFn is in place (it works on both versions).

## Alternatives Considered

Upgrade now — rejected: churn without benefit; risks regressions in the fork's auth flow.

## Consequences

- Positive: no dependency churn in this session.
- Neutral: fork stays one minor version behind upstream.

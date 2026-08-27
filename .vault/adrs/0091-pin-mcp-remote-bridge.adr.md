---
type: adr
id: ADR-0091
title: "Pin mcp-remote >= 0.2.6 in User Config Bridges"
status: accepted
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [mcp, mcp-remote, oauth, config, bridge]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0093-bridge-guidance-instead-of-cli-integration.adr.md"
  - "memories/0020-mcp-remote-0201-signin-bugs.memory.md"
  - "runbooks/0002-mcp-bridge-reauthentication.runbook.md"
---

# ADR-0091: Pin mcp-remote >= 0.2.6 in User Config Bridges

## Context

mcp-remote 0.2.0/0.2.1 (published 2026-08-24) rewrote multi-instance OAuth sign-in coordination (lockfiles, shared 401 flows, callback path) and is buggy — hangs, torn state, 4 stale resource IDs in the 0.2.1 auth store for one IBKR server. Fixes landed 0.2.2–0.2.6 (Aug 25–26). The user's `~/.config/opencode/opencode.jsonc` pinned 0.2.1 across ~10 bridge entries.

## Decision

Edit `~/.config/opencode/opencode.jsonc`: replace `mcp-remote@0.2.1` with `mcp-remote@0.2.6` in all bridge entries, then restart opencode. Config edit, not fork code.

## Alternatives Considered

Leave config and only harden fork code — rejected: daily bridge usage runs through mcp-remote. Pin 0.2.1 — rejected: known buggy. Upgrade to `@latest` — rejected: explicit pin is more deterministic.

## Consequences

- Positive: daily bridge failures fixed by 0.2.2–0.2.6 coordination fixes.
- Positive: no fork code needed for the primary unblock.
- Neutral: config edit is user-level; future mcp-remote releases may require re-pinning.
- Risk: 0.2.6 is same-day release; verified against IBKR (reviewer: 13/13 bridges pinned 0.2.6, live IBKR run exit 0).

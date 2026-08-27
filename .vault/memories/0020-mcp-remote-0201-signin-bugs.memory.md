---
type: memory
title: "mcp-remote 0.2.0/0.2.1 Have Sign-In Coordination Bugs — Pin >= 0.2.6"
createdAt: "2026-08-26T18:11:06Z"
updatedAt: "2026-08-26T18:11:06Z"
tags: [mcp-remote, oauth, bridge, config, gotcha]
see_also:
  - "adrs/0091-pin-mcp-remote-bridge.adr.md"
  - "runbooks/0002-mcp-bridge-reauthentication.runbook.md"
---

# mcp-remote 0.2.0/0.2.1 Have Sign-In Coordination Bugs — Pin >= 0.2.6

## Fact

mcp-remote 0.2.0/0.2.1 (published 2026-08-24) rewrote multi-instance OAuth sign-in coordination (lockfiles, shared 401 flows, callback path) and are buggy: secondary-instance hangs, unshared 401 flows, torn-lockfile handling. Fixes landed in 0.2.2–0.2.6 (Aug 25–26). Pin bridges to `mcp-remote@0.2.6` or newer — never `@latest` (resolves to buggy 0.2.x).

## Context

The user's `~/.config/opencode/opencode.jsonc` pinned 0.2.1; the 0.2.1 auth store showed FOUR distinct resource IDs for the same IBKR server URL — exactly the scenario the 0.2.2+ fixes target. `~/.mcp-auth/` contains per-version stores (0.1.37…0.2.1); 0.2.x uses a different store layout.

## Impact

Bridge hangs/torn state = check the mcp-remote pin first. Upgrade config pin, then restart opencode. Revert = change pin back.

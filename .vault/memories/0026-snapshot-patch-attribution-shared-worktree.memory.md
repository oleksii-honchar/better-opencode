---
type: memory
title: "Patch Parts Attribute the Whole Shared-Worktree Diff to Any Session"
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [snapshot, patch, attribution, incident, gotcha]
system: opencode
see_also:
  - "../specifications/0024-runaway-loop-hardening.spec.md"
---

# Memory: Snapshot Patch Attribution Follows the Shared Worktree, Not the Session

## Fact

Snapshot state is per-project/worktree (`snapshot/index.ts:81`), and
`processor.ts` step-finish/cleanup emit `files: [...patch.files]` — the whole
`git diff --cached` since step-start, including files edited by OTHER concurrent
sessions. On 2026-10-03, 25 distinct sessions carried patch parts snapshotting one
folder's files; the legitimate editor was only one of them.

## Context

Long suspected as a bus-subscription leak; the 2026-10-03 root-cause investigation
refuted that — patch parts are written directly via `session.updatePart` with the
correct `sessionID`, and projectors are session-scoped. The CONTENT (files list)
was wrong, not the routing.

## Impact

Fixed on branch `261003-fix-runaway-loop-hardening` by `attributePatchFiles`
filtering `patch.files` to files the session's tool calls actually touched.
Trade-off: bash-made edits are no longer captured in patch parts. `snapshot.revert`
semantics improve — a session can only revert files it touched.

---
type: memory
title: "Subagents Re-Emit Flat Date Session Paths at Write Time Despite Correct Nested Context"
createdAt: "2026-10-19T14:31:00Z"
updatedAt: "2026-10-19T14:31:00Z"
tags: [agent-sessions, path-shape, subagents, gotcha]
see_also:
  - "../adrs/0113-session-path-guard-tool-layer.adr.md"
  - "./0033-display-normalization-flattens-nested-paths.memory.md"
---

# Memory: Subagents Re-Emit Flat Date Session Paths at Write Time

## Fact

Even when the correct nested session path is handed to a subagent in the delegation block
**and the subagent verified it mid-task**, its subsequent write/edit tool calls spontaneously
re-generate the flat form `~/.agent-sessions/26-10-18/…` — hex-verified tool inputs (`2d`
separators), two independent post-fix reproductions (2026-10-18, 2026-10-19).

## Context

Investigated in session `261019-0812-flat-date-path-issue` after flat orphan trees recurred
despite the 2026-10-18 history.mjs guard and prompt hardening. Strong attractors: the leaf
folder name embeds a flat date (`261018-1815-…`), `26-10-18` is the natural human rendering of
`26/10/18`, and rendered tool output sometimes displays nested paths flat (see
[[0033-display-normalization-flattens-nested-paths.memory.md]]).

## Impact

Prompt/delegation instruction hardening alone cannot fix this class of error — enforcement must
be at the tool layer (DEC-0113). Evidence-hygiene note (review F-1): the session's
`data-flat-tree-audit.txt` keeps the superseded counter `FLAT_FORM_DIRS_ANYWHERE_UNDER_26: 4`
beside the corrected current value `0` — treat **0** (multiple independent post-fix scans,
latest 2026-10-19 ~14:30 UTC) as current truth.

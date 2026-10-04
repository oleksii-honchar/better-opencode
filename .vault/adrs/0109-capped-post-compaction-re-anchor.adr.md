---
type: decision
id: DEC-0109
title: "Rate-Limit the Post-Compaction Re-Anchor Hook (Cap 3 + Recall-First Prompt)"
status: proposed
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [compaction, recall, bensyne, plugin, incident, 2026-10-03]
system: opencode
supersedes: []
superseded_by: []
see_also:
  - "0107-sequential-post-compaction-recall.adr.md"
  - "../specifications/0023-fix-post-compaction-recall-race-condition.spec.md"
  - "../specifications/0024-runaway-loop-hardening.spec.md"
  - "../memories/0029-confabulated-goal-laundered-by-compaction.memory.md"
---

# DEC-0109: Rate-Limit the Post-Compaction Re-Anchor Hook

> **Status note:** implemented on branch `261003-fix-runaway-loop-hardening` (staged,
> not yet committed/merged as of 2026-10-04). Flip to `accepted` after merge.

## Context

The `experimental.compaction.post_recall` hook (DEC-0107) fired on EVERY compaction
with a fixed "re-enter the tree from the start" mandate. In the 2026-10-03 incident
it injected 727 re-anchors; the mandate text self-propagated through goal summaries
(commit `6ffa56759` seed). But the hook's purpose — post-compaction traversal
recovery (DEC-0107) — is legitimate.

## Decision

Keep the hook; cap it at 3 injections per session (in-process Map,
`MAX_REANCHORS_PER_SESSION = 3` in `plugin/bensyne/index.ts`); mark the injected
part with `metadata.compaction_recall` (mirrors the `compaction_continue`
convention); rewrite the prompt to recall traversal-history +
`persona.anchor_file_id` FIRST (bank `agent-session-{sessionID}` — legacy
`agent-sessions_` name removed) and re-enter the entry node only if recall is
empty; delete the "Do not try to recall your prior position" sentence.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| Remove hook | Loses traversal recovery (DEC-0107 purpose) |
| Prompt-only fix | Rejected alone — agent may still re-anchor every pass |
| Message-history check in plugin | Plugin has no message access; cap is simpler |

## Consequences

- Loop cannot self-sustain past 3 passes.
- Auditability via marker: `rg compaction_recall` in session history = re-anchor ground truth.
- Persona trees benefit from recall-first anchor-resume prompt ordering.
- Amends (does not supersede) DEC-0107: invocation remains synchronous.

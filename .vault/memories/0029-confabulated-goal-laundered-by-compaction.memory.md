---
type: memory
title: "Compaction Can Confabulate a Phantom Goal and Launder It as a User Message"
createdAt: "2026-10-04T11:12:29Z"
updatedAt: "2026-10-04T11:12:29Z"
tags: [compaction, confabulation, incident, gotcha]
system: opencode
see_also:
  - "../adrs/0111-compaction-goal-integrity.adr.md"
  - "../adrs/0109-capped-post-compaction-re-anchor.adr.md"
---

# Memory: Summarizer Confabulation Can Hijack a Session Goal

## Fact

On 2026-10-03 a compaction call with ~4.8K tokens of loop boilerplate invented a
phantom task ("Short Engine / XDR alignment contract") with zero local grounding;
the anchored-summary pipeline re-injected it as a USER message ("## Goal -
Implement the Short Engine…"), driving all later passes ("working on somebody
else").

## Context

No local source (other sessions, files, shared banks, recall results) contained
the phantom content. Garbled phrasing ("binary-elp interchange standard",
"notebook medicine") favors weak-model confabulation under the degenerate
repetitive context; provider-side prompt-cache contamination remains a minority
hypothesis, unresolvable locally because the response model is unrecorded
(memory 0027).

## Impact

Motivated DEC-0111 (immutable Original Task + goal-drift tripwire). Operational
rule: treat any Goal section that appears without a real user message as suspect;
the `metadata.goal_drift` marker flags exactly this shape.

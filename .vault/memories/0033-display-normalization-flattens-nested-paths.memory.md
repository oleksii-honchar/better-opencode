---
type: memory
title: "Rendered Tool Output Can Display Nested Session Paths Flat — Trust Hex/Bytes, Verify with find"
createdAt: "2026-10-19T14:31:00Z"
updatedAt: "2026-10-19T14:31:00Z"
tags: [agent-sessions, path-shape, display-normalization, gotcha]
see_also:
  - "../adrs/0113-session-path-guard-tool-layer.adr.md"
  - "./0032-subagent-flat-date-path-generation.memory.md"
---

# Memory: Rendered Output Flattens Nested Paths — Trust Bytes

## Fact

Rendered tool output may normalize path separators — a nested `26/10/18` path can **display**
as `26-10-18`. Earlier "same inode / hardlink" impressions during the investigation were
researcher path-typing errors, resolved only via `stat links=%l`, charCode/xxd dumps, and
`find -print0 | xxd`.

## Context

Discovered while forensically separating "display artifact" from "real flat directory" in
session `261019-0812-flat-date-path-issue` (both existed and were initially conflated).
Independently observed again in the later vault-keeper session (2026-10-19): `find` rendered
the session path as `26-10-19/…`, a hexdump proved the bytes were `26/10/19/…`, and
re-typing the rendered flat form produced a no-such-directory error — the trap stays live.

## Impact

When a session path is contested: hex/codepoint dumps and `find` are ground truth; rendered
output is not. This poisons agent context and feeds the re-emission loop documented in
[[0032-subagent-flat-date-path-generation.memory.md]]; the DEC-0113 WARN log carries an
explicit "trust these bytes, verify with find" note for this reason. Copy session paths
verbatim; never re-type from rendered output.

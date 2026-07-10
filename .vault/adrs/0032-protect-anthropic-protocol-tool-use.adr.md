---
type: adr
id: ADR-0032
title: "Protect Anthropic Protocol tool_use from Meta Tool Rename"
status: accepted
createdAt: "2026-07-09T19:00:00Z"
updatedAt: "2026-07-09T19:00:00Z"
tags: [meta-tools, protocol, boundary, anthropic]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0007-always-extract-skills.adr.md"
  - "adrs/0008-leave-tools-transform-unchanged.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0032: Protect Anthropic Protocol tool_use from Meta Tool Rename

## Context

The `tool_use` string appears in better-opencode source code in two distinct contexts:
1. **Meta tool name** in tests — should be renamed to `meta_use`
2. **Anthropic API protocol reference** in source code — must NOT be renamed

The Anthropic API contract defines `tool_use` as a stop reason and content block type. Changing this would break Anthropic provider functionality. With 100+ `tool_use` occurrences in better-opencode, accidental modification was a real risk during the meta tools rename across 4 repos.

## Decision

Explicitly exclude protocol source files from renaming:
- `packages/llm/src/protocols/anthropic-messages.ts` — excluded (protocol source)
- `packages/opencode/src/session/message-v2.ts` — excluded (protocol source)
- `packages/llm/src/protocols/bedrock-converse.ts` — excluded (protocol source)
- Protocol tests in `llm.test.ts` lines 1618+ — excluded (protocol tests)

An explicit exclude list was maintained and manually verified for each occurrence.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Global find/replace | Fast | Would change protocol refs | Rejected (too dangerous) |
| Context-aware rename | Precise | Complex implementation | Rejected (overkill) |
| **Explicit exclude list** | Simple, auditable | Manual verification needed | **Selected** |

## Consequences

- **Positive:** Anthropic protocol fully preserved — no provider breakage
- **Positive:** All meta tool references renamed correctly in tests
- **Positive:** Manual verification provides audit trail
- **Neutral:** Must verify each `tool_use` occurrence — extra care needed for future renames
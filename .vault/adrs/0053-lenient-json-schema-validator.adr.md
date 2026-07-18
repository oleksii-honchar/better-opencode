---
type: adr
id: ADR-0053
title: "Lenient JSON Schema Validator for MCP Tool Output Validation"
status: accepted
createdAt: "2026-07-17T12:00:00Z"
updatedAt: "2026-07-17T12:00:00Z"
tags: [mcp, validation, json-schema, lenient, additionalProperties]
supersedes: []
superseded_by: []
see_also:
  - "[[0033-absolute-directory-mcp-arguments.adr]]"
  - "[[concepts/0005-agent-meta-tool-plugin.concept]]"
---

# ADR-0053: Lenient JSON Schema Validator for MCP Tool Output Validation

## Context

MCP SDK v1.27.1+ validates tool `structuredContent` against the tool's `outputSchema` JSON Schema using AJV. The `toJsonSchemaCompat()` conversion from Zod to JSON Schema drops optional fields while keeping `additionalProperties: false`, causing valid server responses to fail client-side validation with "additional properties not allowed" — a false positive caused by the conversion, not the server.

**Background:** When MCP servers define tool output schemas using Zod, the `toJsonSchemaCompat()` function converts them to JSON Schema for client-side validation. This conversion drops optional fields from the JSON Schema while preserving `additionalProperties: false`. When a server returns data with optional fields (which is valid), AJV validation fails.

**Evidence:** `packages/opencode/src/mcp/lenient-validator.ts` — 60 lines, 5/5 unit tests passing.

## Decision

Implement a `LenientJsonSchemaValidator` that wraps the default `AjvJsonSchemaValidator`:

1. Tolerates `additionalProperties` validation errors (regex: `/additional properties|excess property/i`)
2. Logs warnings (deduplicated by `${schema.$id}-${error.substring(0,50)}`) for observability
3. Fails on all other validation errors (type mismatches, required fields)

Wired into both MCP Client constructors:
- `connectTransport` at `packages/opencode/src/mcp/index.ts:437`
- OAuth connect at `packages/opencode/src/mcp/index.ts:1039`

## Alternatives Considered

| Alternative | Rejection Reason |
|-------------|------------------|
| Pre-compute broken tools | Heuristic-based, requires per-tool config, fragile to server changes |
| Fix at server level | Doesn't help third-party servers, requires changes to multiple codebases |
| Patch MCP SDK | High maintenance burden, blocks upstream updates |
| Validate with Zod directly | Breaks protocol boundary, requires Zod schemas on client side |

## Consequences

**Positive:**
- Eliminates need for catch-and-retry in tool execution
- No double network calls
- Works for all MCP tools (not just specific ones)
- Uses official `jsonSchemaValidator` extension point

**Negative:**
- Slightly more complex than catch-and-retry
- Must configure at client creation time

## Implementation Status

- ✅ LenientJsonSchemaValidator implemented (`packages/opencode/src/mcp/lenient-validator.ts`)
- ✅ Wired into connectTransport (`packages/opencode/src/mcp/index.ts:437`)
- ✅ Wired into OAuth connect (`packages/opencode/src/mcp/index.ts:1039`)
- ✅ 5/5 unit tests passing
- ⏳ E2E validation pending

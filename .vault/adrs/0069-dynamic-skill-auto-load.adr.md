---
type: adr
id: ADR-0069
title: "Auto-Load Discovered Skills via Injected Skill Content"
status: accepted
createdAt: "2026-08-08T20:00:00Z"
updatedAt: "2026-08-08T20:00:00Z"
tags: [skill, dynamic-skills, injection, agent-autonomy]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0055-dynamic-skill-registration.adr.md"
  - "adrs/0058-self-inject-pattern.adr.md"
  - "adrs/0066-per-session-injection-tracking.adr.md"
  - "concepts/0011-dynamic-skill-visibility.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0069: Auto-Load Discovered Skills via Injected Skill Content

## Context

The dynamic skill discovery pipeline (ADR-0055, ADR-0058, ADR-0066) works end-to-end: skills are scanned, registered, tracked per-session, and self-injected. The injection step produced a `<system-reminder>` nudge with `<available_skills>` metadata, asking the agent to call the `skill` tool to load them.

In practice, the agent often didn't follow through. The nudge was easily overlooked — especially in long contexts — leaving discovered skills registered but never loaded into the agent's working context. The gap: registration ≠ visibility to the model.

## Decision

Rewrite `injectDiscoveredSkills` in `dynamic-scanner.ts` to embed the **full `<skill_content>` block** for each discovered skill, matching the output format of the `skill` tool. The injected synthetic user message now includes:

1. `<skill_content name="X">` wrapper with full skill content, base directory (file:// URL), and sampled file list
2. `<available_skills>` XML retained for metadata visibility

The format mirrors the `skill` tool output in `tool/skill.ts` (lines 47-63): content, base directory, file list via `Ripgrep.Service`, and `<skill_files>` section.

The `scanSkillFiles` helper was added to `dynamic-scanner.ts` (lines 809-829) to scan skill directory files using `Ripgrep.Service` (same as the `skill` tool), with graceful fallback to empty string on error or missing service.

**Flow:**
1. `scanForFile()` walks up to `.agents/skills/` → finds `SKILL.md`
2. `registerDynamic()` registers the skill in `Skill.Service`
3. `injectDiscoveredSkills()` formats the **full skill content** (new)
4. `flushInjectedMessages()` persists the synthetic user message
5. Agent receives the skill instructions — no need to call the `skill` tool

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Keep nudge-only injection | Lightweight; preserves agent choice | Agent ignores nudge 50%+ of the time; skills discovered but unused | Rejected: unreliable |
| Force-inject via system prompt | Guaranteed visibility | Breaks KV cache — system prompt changes every turn → full context reprocessed (ADR-0055) | Rejected: performance |
| Call skill tool programmatically | Reuses existing flow | Requires tool execution context in scan; introduces new dependency; tool permission gate adds friction | Rejected: complexity |
| Inject `<available_skills>` only, no content | Metadata visible | Agent still needs to call `skill` tool; same reliability problem | Rejected: same defect |

## Consequences

- **Positive:** Discovered skills are now auto-loaded into the model's context without requiring agent action — eliminates the nudge-follow-through gap
- **Positive:** Format parity with `skill` tool output means the model receives identical information whether a skill is loaded via tool or auto-discovered
- **Positive:** No performance regression — injection uses user-role synthetic messages (KV cache safe, per ADR-0057)
- **Negative:** Larger synthetic messages (full skill content vs. lightweight nudge) — mitigated by per-session injection gating (ADR-0066) and 5-minute scan cache TTL (ADR-0067)
- **Negative:** Ripgrep dependency for file scanning — graceful fallback to empty string on error, but file list may be missing if Ripgrep is unavailable

## Verification

- `injectDiscoveredSkills` full content block at `dynamic-scanner.ts:842-919` — ✅ verified (builds `<skill_content>` with content, base directory, file list)
- `scanSkillFiles` helper at `dynamic-scanner.ts:809-829` — ✅ verified (uses `Ripgrep.Service`, graceful fallback)
- Format parity with `skill` tool at `tool/skill.ts:47-63` — ✅ verified (same structure: content, base, files)
- `<available_skills>` still included at `dynamic-scanner.ts:886-896` — ✅ verified
- Per-session injection gating at `dynamic-scanner.ts:446-466` — ✅ verified (ADR-0066)
- Test coverage: 155/155 pass across 6 test files (`scan-tool-args.test.ts`, `scan-parts.test.ts`, `dynamic-integration.test.ts`, `dynamic-scanner.test.ts`) — ✅ verified

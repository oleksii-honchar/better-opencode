---
type: specification
kind: feature
status: completed
title: "rules-inject: Opt-in \"after persona\" Injection Position"
createdAt: "2026-08-10T09:58:08Z"
updatedAt: "2026-08-10T09:58:08Z"
tags: [plugin, rules-inject, system-prompt, config]
owner: ""
target: null
see_also:
  - "adrs/0070-rules-inject-position-config.adr.md"
  - "adrs/0071-rules-inject-after-persona-placement.adr.md"
  - "concepts/0002-system-prompt.concept.md"
---

# Specification: rules-inject — Opt-in "after persona" Injection Position

## Goal

Add an opt-in `position` config param to the built-in `rules-inject` plugin so always-apply rules can be injected AFTER the agent persona block (between persona and the env block) instead of prepended. Default remains `"before"` — backward compatible, additive/opt-in.

## Key Components

1. **`packages/opencode/src/plugin/rules-inject/config.ts`** — `position: "before" | "after-persona"` added to `RulesInjectConfig` interface + `defaultConfig.position = "before"`. `mergeConfig` spread forwards it (unchanged).
2. **`packages/opencode/src/plugin/rules-inject/index.ts`** — config hook inline cast extended with `position?`; transform hook gains placement branch: `indexOf("You are powered by the model named")` → insert `rules + "\n\n"` before marker; marker absent → prepend fallback + `log.debug`. Dedupe `injected` Set and guards unchanged.
3. **`packages/opencode/src/config/config.ts`** (~line 428) — schema: `position: Schema.optional(Schema.Literals(["before", "after-persona"]))`, matching existing enum-field pattern (`share`, `compaction`).
4. **`packages/sdk/js/src/v2/gen/types.gen.ts`** (~line 1376-1379) — `position?: "before" | "after-persona"` via 1-line manual patch (regeneration produced 131 unrelated lines from 4 later commits; ADR-003 fallback applied).
5. **`docs/spec/18-rules-inject-plugin.md`** — position row in Config Key Reference + after-persona example + placement behavior note.
6. **`~/.config/opencode/opencode.jsonc`** (line ~11) — `"position": "after-persona"` enabled in `rulesInject` block.

## Behaviors

- position `"before"` (default): `system[0] = rules + "\n\n" + system[0]` — unchanged prepend
- position `"after-persona"`: split at env marker, insert rules before it; fallback to prepend + debug log if marker absent
- Guards preserved: `enabled`, `sessionID`, dedupe `injected`, empty rules, empty system all short-circuit before placement

## Risks

- Env marker missing in unusual paths → LOW (fallback prepend + debug log)
- Invalid `position` value → LOW (`Schema.Literals` rejects at decode)
- SDK types drift → LOW (type-only, manual patch verified)

## Verification

- Tests: `rules-inject.test.ts` (17 pass), `config.test.ts` (10 pass), `config.test.ts` root (27 pass) — 54 assertions total
- `bun turbo typecheck`: 15/15 packages, 0 errors
- Manual: rules appear after persona, before "You are powered by the model named" env block

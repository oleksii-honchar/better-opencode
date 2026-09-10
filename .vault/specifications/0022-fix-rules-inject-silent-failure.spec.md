---
type: specification
kind: bugfix
status: completed
title: "Fix rules-inject Silent Failure"
createdAt: "2026-09-10T14:30:00Z"
updatedAt: "2026-09-10T14:30:00Z"
tags: [plugin, rules-inject, observability, bugfix]
owner: ""
target: null
see_also:
  - "adrs/0106-fix-rules-inject-silent-failure.adr.md"
  - "adrs/0070-rules-inject-position-config.adr.md"
  - "adrs/0071-rules-inject-after-persona-placement.adr.md"
  - "concepts/0002-system-prompt.concept.md"
---

# Specification: Fix rules-inject Silent Failure

## Goal

Fix the `rules-inject` plugin's silent failure when the config hook does not receive user config, causing the plugin to fall back to a non-existent default folder. Make the failure observable through structured logging at every decision point.

## Root Cause

The plugin's config hook was not receiving the user's `rulesInject` configuration from `opencode.jsonc`. As a result, `activeConfig.alwaysApplyFolder` remained at the default value `~/.rules/always-apply`, which did not exist on the user's system. `loadRules` returned an empty string, and the transform hook exited without injecting rules or logging anything.

## Key Components

1. **`packages/opencode/src/plugin/rules-inject/index.ts`** — config hook extended to properly extract `rulesInject` from `cfg` and log configured values; transform hook gains structured logging at every decision point (enabled check, sessionID check, rules load, empty prompt check, successful injection).

2. **`packages/opencode/src/plugin/rules-inject/rules-inject.test.ts`** — new test case "injection works with user-configured folder" simulates the real-world scenario with user config passed to the plugin.

3. **`packages/opencode/src/config/config.test.ts`** — new integration test verifies `rulesInject` config survives JSON parsing and schema validation.

## Behaviors

- Config hook receives and stores user config from `opencode.jsonc`
- Config hook logs: `rules-inject configured { enabled, folder, position }`
- Transform hook logs at every early-return point (debug/warn levels)
- Transform hook logs on successful injection: `rules-inject: injected rules { sessionID, rulesLength, position }`
- Default folder path `~/.rules/always-apply` preserved for backward compatibility

## Risks

- Increased log volume — LOW (appropriate log levels used: debug for early exits, warn for failures, info for success)
- Config parsing regression — LOW (integration test covers parsing flow)

## Verification

- All 18 plugin tests pass
- All 43 config rulesInject tests pass
- Manual verification: logs show `rules-inject configured` and `rules-inject: injected rules` with correct folder and rules length
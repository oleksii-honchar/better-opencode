---
type: adr
id: ADR-0106
title: "Fix rules-inject Silent Failure with Observable Logging"
status: accepted
createdAt: "2026-09-10T14:30:00Z"
updatedAt: "2026-09-10T14:30:00Z"
tags: [plugin, rules-inject, observability, logging, bugfix]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0070-rules-inject-position-config.adr.md"
  - "adrs/0071-rules-inject-after-persona-placement.adr.md"
  - "specifications/0022-fix-rules-inject-silent-failure.spec.md"
  - "concepts/0002-system-prompt.concept.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# ADR-0106: Fix rules-inject Silent Failure with Observable Logging

## Context

The `rules-inject` plugin silently failed to inject rules when its config hook did not receive the user's `rulesInject` configuration. The plugin fell back to the default folder `~/.rules/always-apply`, which did not exist on the user's system, causing `loadRules` to return an empty string. The transform hook exited without injecting anything and without any logging, leaving users unable to diagnose the failure.

Three decisions were made to fix this:
1. Fix the config hook to properly receive and store user config (root cause)
2. Add structured logging at every decision point in the transform hook (observability)
3. Keep the default folder path `~/.rules/always-apply` for backward compatibility
4. Add an integration test for the full config → plugin loading flow

## Decision

Make the plugin failure observable by adding structured logging at every decision point in the transform hook. The root cause fix (ensuring the config hook receives user config) is applied alongside the logging improvements. The default folder path remains `~/.rules/always-apply` for backward compatibility.

### Config Hook Fix

The config hook now properly extracts and stores the `rulesInject` configuration from the user's config object, logging the configured values (enabled, folder, position).

### Observable Failure Logging

The transform hook logs at every decision point:
- `log.debug("rules-inject disabled")` — when the plugin is disabled
- `log.debug("rules-inject: no sessionID, skipping")` — when no sessionID is present
- `log.warn("rules-inject: no rules loaded from folder", { folder })` — when loadRules returns empty
- `log.warn("rules-inject: empty system prompt, cannot inject")` — when system prompt is empty
- `log.info("rules-inject: injected rules", { sessionID, rulesLength, position })` — on successful injection

### Backward Compatibility

The default folder path `~/.rules/always-apply` is preserved to avoid breaking existing users who rely on the current default. Users should configure `alwaysApplyFolder` to match their actual rules location.

### Integration Testing

An integration test verifies the full config → plugin loading flow, ensuring the actual failure scenario (config resolution → plugin loading → rule injection) is covered.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Change default folder to `~/.rules/olho/always-apply` | Works for this user | Not universal; breaks other users | Rejected: not generic |
| Throw exception when no rules loaded | Immediate visibility | Breaks the request | Rejected: too disruptive |
| Add config validation at startup | Catches misconfig early | Complex; requires config system changes | Rejected: overengineering |

## Consequences

- **Positive:** Users can now diagnose rules-inject failures by reading logs
- **Positive:** Root cause fixed — user config is properly received by the plugin
- **Positive:** Integration test prevents regression of the config loading flow
- **Negative:** Slightly increased log volume (debug/warn/info messages)
- **Neutral:** Default folder path unchanged; users must still configure `alwaysApplyFolder` correctly
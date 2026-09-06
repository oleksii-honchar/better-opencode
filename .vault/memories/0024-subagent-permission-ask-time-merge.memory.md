---
type: memory
title: "Subagent Permission Ask-Time Merge — Agent Allows Win Unless Session *:ask Lands Last"
createdAt: "2026-09-05T19:50:00Z"
updatedAt: "2026-09-05T19:50:00Z"
tags: [permission, subagent, external_directory, findLast, task-tool]
---

# Memory: Subagent Permission Ask-Time Merge — Agent Allows Win Unless Session *:ask Lands Last

## What

The permission ask at tool-execution time (`packages/opencode/src/session/tools.ts:270`)
merges the agent's own rules with the session rules:

```ts
ruleset: Permission.merge(input.agent.permission, input.session.permission ?? [])
```

`PermissionV2.evaluate` (`packages/core/src/permission.ts:21-31`) flattens ALL
rulesets and applies `findLast` — the **last matching rule wins**. No match → the
fallback default `{ action: "ask" }`.

## Why it matters

- An agent-file `permission.external_directory: { "/Volumes/Data/www/*": "allow" }`
  IS resident in `Agent.Info.permission` (`agent.ts:378`), so it is present at ask
  time even for task-spawned subagents (whose session `agent: next.name` is the
  subagent type — `task.ts:173`).
- With an empty/`NULL` session permission (the norm in `opencode.db`: primary
  sessions store `[]`/`NULL`, subagents store only a `task:deny` rule), the merged
  ruleset = agent rules only → allow wins → **no prompt**.
- A prompt can still fire if the merged ruleset has a LATER matching rule with
  action `ask` (e.g. a session `external_directory: { "*": "ask" }` placed after
  the agent allow) — `findLast` semantics.
- `Wildcard.match` (`packages/core/src/util/wildcard.ts`) turns `*` → `.*` with the
  `s` flag, so `/Volumes/Data/www/*` matches deep paths — the glob is NOT the
  culprit for misses.

## Gotcha

When forwarding subagent-own allows into a derived session ruleset
(`deriveSubagentSessionPermission`), the ordering matters: place the subagent's
allows AFTER parent external `*:ask` rules but BEFORE parent denies, so `findLast`
picks the allow while explicit denies still win.

## Lesson

Debugging "why am I still asked for a path I allowed" is rarely a missing agent
rule — verify the actual ask-time merged ruleset and its ordering. Real session
permissions are stored in `opencode.db` `session.permission` (JSON). If the parent
session carries a `*:ask` external rule that lands last in the merge, that is the
override.
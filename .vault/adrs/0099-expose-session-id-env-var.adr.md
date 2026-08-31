---
type: adr
title: "Expose OPENCODE_SESSION_ID in Bash-Tool Child Envs"
status: accepted
date: "2026-08-31"
see_also:
  - "[[0050-pass-original-session-id.adr.md]]"
tags: [session-id, env-var, bash-tool, subagent]
---

# Expose OPENCODE_SESSION_ID in Bash-Tool Child Envs

## Context

The bensyne-personas history recorder (`~/.config/opencode/agents/scripts/history.mjs`)
wrote only the scaffold `sessionId` from `session.md` frontmatter. For delegated
sub-agents that frontmatter carries the **parent-created** id, so the running agent's
own session id (its `<env>` Session ID) was lost — parent/child relationships between
sub-session folders were unrecoverable.

The fork rendered `Session ID:` / `Parent Session ID:` only as prompt text
(`session/system.ts`), never to `process.env`. Precedents for identity env vars
already existed: `OPENCODE_PID` (`index.ts:110`), `OPENCODE_RUN_ID` (`thread.ts:143`).

## Decision

Inject the running session's id into bash-tool child environments as
`OPENCODE_SESSION_ID` at the existing env-merge site, reusing the `input.sessionID`
already passed to the `shell.env` plugin hook:

- File: `packages/opencode/src/session/prompt.ts:698`
- Change: `env: { ...shellEnv.env, TERM: "dumb", OPENCODE_SESSION_ID: input.sessionID }`
- Fork commit: `a1c0522dd4` ("chore(opencode): add OpenCode session ID to the
  environment for child processes")

## Cross-Repo Contract (agent-rules-n-skills catalogue)

`history.mjs` v2.3 (catalogue + shipped, kept byte-identical via `agents.sh update`)
reads `process.env.OPENCODE_SESSION_ID` in write mode and emits two optional fields:

- `subAgentSessionId` — the env value, when set and non-empty
- `parentSessionId` — the scaffold `sessionId` (frontmatter), only when it differs
  from `subAgentSessionId` (keeps root-agent records clean)

Both keys are omitted when the env var is absent — existing records stay parseable
and `--query` output shape is unchanged. Verified: 18/18 tests green
(`history.test.mjs` T14/T15/T16), shipped diff identical.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| CLI flags `--subAgentSessionId` / `--parentSessionId` | Breaks every agent-wrapper invocation; user chose env-derived (Option A) |
| Read `session.parentID` from the fork DB | `history.mjs` is stdlib-only, no DB access; out of scope |
| PTY/terminal env injection | `pty/index.ts:196` passes only `{ cwd }` to the hook; needs `sessionID` plumbing through `CreateInput`/ticket — deferred as optional follow-up (bash-tool path covers all `history.mjs` invocations) |

## Consequences

- **Positive:** Sub-agent history records now carry the parent/child session
  relationship; Racochu-ingested session banks become queryable by lineage.
- **Negative/Neutral:** Envs without the var (old fork, PTY terminals) simply omit
  the fields — backwards-compatible by design. Value is `ses_<hex>` (safe
  characters), so no shell-metacharacter risk at the env-merge site.
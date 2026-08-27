---
type: adr
id: ADR-0096
title: "Make AppFileSystem.readJson Defect-Safe (typed parse errors)"
status: accepted
createdAt: "2026-08-27T17:04:04Z"
updatedAt: "2026-08-27T17:04:04Z"
tags: [mcp, oauth, fetch-guard, sdk, bugfix, defect-safety, effect, filesystem]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0092-guard-oauth-http-parsing.adr.md"
  - "specifications/0019-mcp-oauth-auth-reliability.spec.md"
---

# ADR-0096: Make AppFileSystem.readJson Defect-Safe (typed parse errors)

## Context

Verified fatal crash chain, field-reproduced in the
`260827-0903-oauth-auto-open-limit` session (Round 2 — defect-safe `readJson`):
a corrupt `mcp-auth.json` (trailing NUL byte + truncated final `}`) was read
by `AppFileSystem.readJson` (`packages/core/src/filesystem.ts`), where the
original `JSON.parse(text)` throw propagated **raw** — the parse ran outside
Effect, so the throw became an Effect **defect** (exception channel) rather
than the typed failure the `Effect.Effect<unknown, Error>` signature
declared. The defect then escaped `McpAuth.all()`
(`packages/opencode/src/mcp/auth.ts:65`), whose typed-only `Effect.catch`
only intercepts the failure channel. From there the defect reached
`Effect.runPromise` in `McpOAuthProvider.tokens()/clientInformation()`
and surfaced as an unhandled rejection that the top-level handler converted
to a fatal exit 1 — taking down `better-opencode mcp list` (and any other
caller path that touched a corrupt shared-state JSON file). The fix lands
on `fix/260827-mcp` (commit pending Task 7 user approval).

This ADR is the filesystem-boundary sibling of ADR-0092, which guards the
HTTP-boundary for SDK `response.json()` calls. Both close the same shape of
defect (un-typed parse throwing across an Effect boundary), one in the
network layer and one in the storage layer.

## Decision

Two coordinated changes inside the existing repo idioms — no new error type,
no new dependency:

1. **`packages/core/src/filesystem.ts:85-91`** — wrap the parse in
   `Effect.try`, mapping the throw to the existing `FileSystemError`:

   ```ts
   const readJson = Effect.fn("FileSystem.readJson")(function* (path: string) {
     const text = yield* fs.readFileString(path)
     return yield* Effect.try({
       try: () => JSON.parse(text),
       catch: (cause) => new FileSystemError({ method: "readJson", cause }),
     })
   })
   ```

   This restores the declared error channel (`Effect.Effect<unknown,
   Error>`), follows the same `Effect.try` pattern already used in
   `readDirectoryEntries` (same file, lines 70-83), `effect-flock.ts:240`,
   and `cross-spawn-spawner.ts:304`. The `NotFound` path is unchanged.

2. **`packages/opencode/src/mcp/auth.ts:67-75`** — make the existing
   `McpAuth.all()` fallback **observable** for non-`NotFound` failures
   only, without changing the `{}` fallback semantics:

   ```ts
   Effect.catch((error) => {
     // A missing file is the normal first-run case — must stay silent.
     // Warn only when the file exists but failed to read/parse.
     const isNotFound = "reason" in error && error.reason._tag === "NotFound"
     if (!isNotFound) {
       log.warn("mcp-auth.json read failed; treating as empty (servers may need re-auth)", { error })
     }
     return Effect.succeed({} as AuthData)
   }),
   ```

   The guard uses the codebase idiom (filesystem.ts:112 — `error.reason._tag
   === "NotFound"` on the wrapped `PlatformError`), and the warning uses
   `log.warn` (the only method exposed by `Logger` in `core/util/log.ts`).

## Alternatives Considered

- **`Effect.catchAll` at the `McpAuth.all()` layer only** — rejected:
  fixes exactly one consumer. The same `readJson` defect is reachable from
  ~60 other call sites (model.json reads, package.json reads,
  account/import data, etc.) and any of them could one corrupt file away
  from the same fatal defect. Minimal change at the root (the utility that
  owns the parse) protects all of them.
- **NUL-strip / content sanitization inside `readJson`** — rejected
  (also ADR-11): a generic file utility silently repairing corrupt JSON
  masks real corruption and papers over data loss — wrong layer, wrong
  semantics. The observed corruption was **two-part** (trailing NUL **and**
  truncated final `}`); NUL-stripping alone would not have saved the
  observed file. With the typed-error fix in place, corruption is no
  longer fatal — the worst case is a re-auth, so a silent sanitizer
  adds risk without removing any remaining failure mode.
- **New dedicated `JsonParseError` type** — rejected: `FileSystemError`
  already carries `method` + `cause` and is already in the declared error
  union for `readJson`; adding a sibling error type would only inflate the
  error channel without adding information.

## Consequences

- Positive: corrupt shared-state files (`mcp-auth.json`, `model.json`,
  `package.json` reads, account data, import data) degrade to typed
  failures instead of process crashes for **all ~64 `readJson` call
  sites**. 5+ call sites with pre-existing failure handlers
  (`auth/index.ts:64`, `npm.ts:158-203`, `account.ts:154-157`,
  `import.ts:155`, `variant.shared.ts:146`) start working for corrupt files
  — they already had the right shape, they were just being bypassed by the
  defect.
- Positive: `McpAuth` corrupt-file fallback is now observable — a warning
  reaches the user/dev.log so silent re-auth isn't silent.
- Positive: first-run silence preserved — `NotFound` (no file yet) is the
  normal case on every fresh install and must not warn.
- Positive: the same 4-line `Effect.try` wrap is portable to upstream
  opencode (the latent defect exists there too — same `JSON.parse` outside
  Effect).
- Negative (acceptable): corrupt inputs now surface as typed errors some
  call sites may show as task errors — strictly better than a dead process.
- Future: the Promise-based helper at
  `packages/opencode/src/util/filesystem.ts:43-45` has the same raw-parse
  pattern but throws a normal Promise rejection (catchable, not a
  defect), is not on the verified fatal path, and its existing tests
  assert the current rejection behavior — **left untouched** in this round
  (ADR-12). Revisit with evidence if a future defect report traces there.
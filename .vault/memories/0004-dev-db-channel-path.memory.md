---
type: memory
title: "Dev Mode Database Path Depends on InstallationChannel (opencode-local.db vs opencode.db)"
createdAt: "2026-06-28T16:00:00Z"
updatedAt: "2026-06-28T16:00:00Z"
tags: [database, dev-server, installation-channel, start-dev-sh, configuration]
see_also:
  - "specifications/0001-opencode-db-cleanup.spec.md"
  - "adrs/0005-journal-size-limit.adr.md"
  - "memories/0002-no-automated-db-maintenance.memory.md"
  - "runbooks/0001-opencode-db-maintenance.runbook.md"
  - "memories/0001-part-table-dominance.memory.md"
  - "scripts/start-dev.sh.md"
---

# Memory: Dev Mode Database Path Depends on InstallationChannel (opencode-local.db vs opencode.db)

## Fact

When running better-opencode in **dev mode** (via `bun run --conditions=browser src/index.ts` or `scripts/start-dev.sh`), the SQLite database writes to:

```
~/.local/share/opencode/opencode-local.db
```

— not `opencode.db`. This is because the dev build does not inject the `OPENCODE_CHANNEL` global, so `InstallationChannel` falls back to `"local"`, producing the `-local` suffix.

## Mechanism

The DB path is determined in `packages/opencode/src/storage/db.ts`:

```typescript
function getChannelPath(flags) {
  if (["latest", "beta", "prod"].includes(InstallationChannel) || flags.disableChannelDb)
    return path.join(Global.Path.data, "opencode.db")
  const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(Global.Path.data, `opencode-${safe}.db`)  // → opencode-local.db
}
```

`InstallationChannel` (from `packages/core/src/installation/version.ts`) reads the global `OPENCODE_CHANNEL` const — which is only injected during a production build via `Bun.build({ define: { OPENCODE_CHANNEL } })`. In dev mode (`bun run`), the global is undefined, so the fallback `"local"` is used.

## How We Fixed It

Added `export OPENCODE_DISABLE_CHANNEL_DB=1` to `scripts/start-dev.sh` (line 307), which sets the `RuntimeFlags.disableChannelDb` flag and forces `getChannelPath()` to return `opencode.db` unconditionally.

## Alternative Override

Set the `OPENCODE_DB` env var to an absolute path to completely bypass the channel logic:

```bash
export OPENCODE_DB=/Users/oleksii.honchar/.local/share/opencode/opencode.db
```

If `OPENCODE_DB` is set and absolute, `getPath()` uses it directly (line 39-41 of `db.ts`):

```typescript
if (Flag.OPENCODE_DB) {
  if (path.isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
}
```

## Binary Resolution (bin/opencode wrapper)

In `packages/opencode/bin/opencode`, the Node.js wrapper resolves a native binary by checking (in order):
1. `$OPENCODE_BIN_PATH` env var
2. `.opencode` cache file (same directory)
3. `node_modules/opencode-{platform}-{arch}/bin/opencode`
4. AVX2 detection for x64 baseline variants

The fork's dev mode (`scripts/start-dev.sh`) skips this entirely — it runs from source via `bun run`.

## Impact

- Running the fork dev server alongside the official brew-installed opencode will use **different databases** (unless `OPENCODE_DISABLE_CHANNEL_DB` or `OPENCODE_DB` is set).
- This may cause confusion when switching between the fork and the official binary — sessions, config, and history live in different DB files.

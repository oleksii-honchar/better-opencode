import { describe, expect, test } from "bun:test"
import path from "path"
import { DEFAULT_ENGINE_INPUTS, resolveInspectorDbPath, openInspectorDb } from "./db"
import { makeFixtureDb, readBytes, tempDirs } from "./session-inspector.test-utils"

// Task 2 §5.1-4 / DEC-E: the inspector must mirror `storage/db.ts` getPath()/getChannelPath()
// precedence EXACTLY (measured anchors: db.ts L31-44 at 4dc7a5d31):
//   Flag.OPENCODE_DB set  → ":memory:" or absolute used verbatim, else joined onto data dir
//   else channel in [latest,beta,prod] or disableChannelDb → <data>/opencode.db
//   else → <data>/opencode-<channel with [^a-zA-Z0-9._-] → "-">.db
// Plus: explicit config path (paths.dbMode ≠ "engine-derived") wins LAST (DEC-E).
// Open is READ-ONLY, never migrates. The second live DB is reachable only by explicit selection.

const DATA = path.join("/tmp", "data")

describe("resolveInspectorDbPath — engine precedence mirrors db.ts exactly", () => {
  test("channel default (latest/beta/prod or disableChannelDb) → opencode.db", () => {
    for (const channel of ["latest", "beta", "prod"]) {
      expect(
        resolveInspectorDbPath({
          dbMode: "engine-derived",
          engine: { ...DEFAULT_ENGINE_INPUTS, channel, dataDir: DATA },
        }),
      ).toBe(path.join(DATA, "opencode.db"))
    }
    expect(
      resolveInspectorDbPath({
        dbMode: "engine-derived",
        engine: { ...DEFAULT_ENGINE_INPUTS, channel: "feat-work", disableChannelDb: true, dataDir: DATA },
      }),
    ).toBe(path.join(DATA, "opencode.db"))
  })

  test("non-default channel → profile-suffixed file, same sanitizer as db.ts", () => {
    expect(
      resolveInspectorDbPath({
        dbMode: "engine-derived",
        engine: { ...DEFAULT_ENGINE_INPUTS, channel: "patched/dev2", dataDir: DATA },
      }),
    ).toBe(path.join(DATA, "opencode-patched-dev2.db"))
    expect(
      resolveInspectorDbPath({
        dbMode: "engine-derived",
        engine: { ...DEFAULT_ENGINE_INPUTS, channel: "weird channel!!", dataDir: DATA },
      }),
    ).toBe(path.join(DATA, "opencode-weird-channel--.db"))
  })

  test("OPENCODE_DB: absolute and :memory: verbatim; bare name joined onto data dir", () => {
    expect(
      resolveInspectorDbPath({
        dbMode: "engine-derived",
        engine: { ...DEFAULT_ENGINE_INPUTS, envOpenCodeDb: "/abs/wherever.db", channel: "beta", dataDir: DATA },
      }),
    ).toBe("/abs/wherever.db")
    expect(
      resolveInspectorDbPath({
        dbMode: "engine-derived",
        engine: { ...DEFAULT_ENGINE_INPUTS, envOpenCodeDb: ":memory:", dataDir: DATA },
      }),
    ).toBe(":memory:")
    expect(
      resolveInspectorDbPath({
        dbMode: "engine-derived",
        engine: { ...DEFAULT_ENGINE_INPUTS, envOpenCodeDb: "fallback.db", dataDir: DATA },
      }),
    ).toBe(path.join(DATA, "fallback.db"))
  })

  test("OPENCODE_DB beats channel-derived path (first branch wins, like db.ts)", () => {
    expect(
      resolveInspectorDbPath({
        dbMode: "engine-derived",
        engine: { ...DEFAULT_ENGINE_INPUTS, envOpenCodeDb: "fallback.db", channel: "patched/dev2", dataDir: DATA },
      }),
    ).toBe(path.join(DATA, "fallback.db"))
  })
})

describe("resolveInspectorDbPath — explicit config path (paths.dbMode) wins last", () => {
  test("second live DB selectable only via explicit config, regardless of env/channel", () => {
    const explicit = path.join(DATA, "opencode-patched-dev2.db")
    expect(
      resolveInspectorDbPath({
        dbMode: explicit,
        engine: { ...DEFAULT_ENGINE_INPUTS, envOpenCodeDb: "/abs/other.db", channel: "latest", dataDir: DATA },
      }),
    ).toBe(explicit)
  })

  test("no automatic merge / no discovery: engine-derived default never guesses the suffixed file", () => {
    const resolved = resolveInspectorDbPath({
      dbMode: "engine-derived",
      engine: { ...DEFAULT_ENGINE_INPUTS, channel: "latest", dataDir: DATA },
    })
    expect(resolved).toBe(path.join(DATA, "opencode.db"))
  })
})

describe("openInspectorDb — read-only, never migrates", () => {
  test("fixture DB: reads succeed, writes throw, file bytes unchanged, no migration artifacts", () => {
    const dirs = tempDirs()
    const dbPath = path.join(dirs.configDir, "fixture.db")
    try {
      makeFixtureDb(dbPath)
      const before = readBytes(dbPath)

      const db = openInspectorDb(dbPath)
      try {
        const rows = db.query("SELECT id, title FROM session").all() as { id: string; title: string }[]
        expect(rows).toEqual([{ id: "ses_fixture", title: "fixture session" }])

        // read-only: any write attempt throws
        expect(() => db.run("INSERT INTO session (id, title) VALUES ('ses_nope', 'nope')")).toThrow()

        // never migrates: no drizzle migration bookkeeping table was created
        const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
        expect(tables.map((t) => t.name)).not.toContain("_drizzle_migrations")
      } finally {
        db.close()
      }

      const after = readBytes(dbPath)
      expect(after.equals(before)).toBe(true)
    } finally {
      dirs.cleanup()
    }
  })
})

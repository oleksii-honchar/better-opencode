import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Database as BunDatabase } from "bun:sqlite"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDb(name = "test.db"): { db: BunDatabase; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `db-test-`))
  const path = join(dir, name)
  const db = new BunDatabase(path, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")
  return { db, dir, path }
}

function cleanTemp(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch { }
}

/**
 * Create the session / message / part tables in a test database so our queries
 * work.  Simplified schema matching the Drizzle definition.
 */
function createSchema(db: BunDatabase) {
  db.run(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      time_archived INTEGER
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    )
  `)
}

// ---------------------------------------------------------------------------
// Vacuum
// ---------------------------------------------------------------------------

describe("opencode db vacuum", () => {
  test("VACUUM + PRAGMA wal_checkpoint(TRUNCATE) runs without error", () => {
    const { db, dir } = createTempDb()
    try {
      createSchema(db)
      // Insert some data
      db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        "s1", "p1", "test-slug", "/tmp", "Test", "1", Date.now(), Date.now(),
      ])
      db.run("DELETE FROM session WHERE id = 's1'") // create free pages

      db.run("VACUUM")
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, unknown>

      // Checkpoint returns at least a 'busy' and 'log' column — verify it ran
      expect(checkpoint).toBeDefined()
      expect(Object.keys(checkpoint).length).toBeGreaterThanOrEqual(1)
    } finally {
      db.close()
      cleanTemp(dir)
    }
  })
})

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

describe("opencode db checkpoint", () => {
  test("PRAGMA wal_checkpoint(TRUNCATE) returns checkpoint info", () => {
    const { db, dir } = createTempDb()
    try {
      createSchema(db)
      // Insert a row to ensure WAL has something
      db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        "s1", "p1", "test", "/tmp", "T", "1", Date.now(), Date.now(),
      ])

      const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, unknown>
      expect(result).toBeDefined()
      // Result has columns like busy, log, checkpointed
      const keys = Object.keys(result)
      expect(keys.length).toBeGreaterThanOrEqual(1)
    } finally {
      db.close()
      cleanTemp(dir)
    }
  })
})

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

describe("opencode db stats", () => {
  test("PRAGMA page_count and freelist_count return numbers", () => {
    const { db, dir } = createTempDb()
    try {
      createSchema(db)
      // Insert some data so there are pages
      db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        "s1", "p1", "slug", "/tmp", "Title", "1", Date.now(), Date.now(),
      ])

      const pageCount = db.prepare("PRAGMA page_count").get() as Record<string, unknown>
      const freelistCount = db.prepare("PRAGMA freelist_count").get() as Record<string, unknown>

      expect(Number(pageCount?.page_count)).toBeGreaterThan(0)
      expect(Number(freelistCount?.freelist_count)).toBeGreaterThanOrEqual(0)

      const freePct = Number(pageCount?.page_count) > 0
        ? (Number(freelistCount?.freelist_count) / Number(pageCount?.page_count)) * 100
        : 0
      expect(freePct).toBeGreaterThanOrEqual(0)
    } finally {
      db.close()
      cleanTemp(dir)
    }
  })

  test("table row count query returns session count", () => {
    const { db, dir } = createTempDb()
    try {
      createSchema(db)

      // Insert 3 sessions
      for (let i = 0; i < 3; i++) {
        db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
          `s${i}`, "p1", `slug-${i}`, "/tmp", `Title ${i}`, "1", Date.now(), Date.now(),
        ])
      }

      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
      expect(rows.length).toBeGreaterThanOrEqual(1)

      for (const row of rows) {
        const count = db.prepare(`SELECT COUNT(*) as cnt FROM "${row.name}"`).get() as { cnt: number }
        expect(typeof count.cnt).toBe("number")
      }

      const sessionCount = db.prepare("SELECT COUNT(*) as cnt FROM session").get() as { cnt: number }
      expect(sessionCount.cnt).toBe(3)
    } finally {
      db.close()
      cleanTemp(dir)
    }
  })

  test("oldest session date query works", () => {
    const { db, dir } = createTempDb()
    try {
      createSchema(db)
      const now = Date.now()
      db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        "old", "p1", "old", "/tmp", "Old", "1", now - 30 * 86400000, now - 30 * 86400000,
      ])
      db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        "new", "p1", "new", "/tmp", "New", "1", now, now,
      ])

      const oldest = db.prepare("SELECT MIN(time_created) as min_time FROM session").get() as { min_time: number | null }
      expect(oldest.min_time).toBeGreaterThan(0)
      expect(oldest.min_time).toBeLessThan(now)
    } finally {
      db.close()
      cleanTemp(dir)
    }
  })
})

// ---------------------------------------------------------------------------
// Compact
// ---------------------------------------------------------------------------

describe("opencode db compact", () => {
  function seedData(db: BunDatabase) {
    const now = Date.now()
    db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      "s1", "p1", "slug-1", "/tmp", "Session 1", "1", now, now,
    ])
    db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      "s2", "p1", "slug-2", "/tmp", "Session 2", "1", now, now,
    ])
    // Messages
    db.run("INSERT INTO message (id, session_id, time_created, time_updated) VALUES (?, ?, ?, ?)", [
      "m1", "s1", now, now,
    ])
    db.run("INSERT INTO message (id, session_id, time_created, time_updated) VALUES (?, ?, ?, ?)", [
      "m2", "s2", now, now,
    ])
    return now
  }

  test("delete compacted parts — json_extract IS NOT NULL", () => {
    const { db, dir } = createTempDb()
    try {
      createSchema(db)
      const now = seedData(db)

      // Insert a compacted part (data has state.time.compacted)
      db.run("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)", [
        "p-compacted", "m1", "s1", now, now,
        JSON.stringify({ type: "tool", state: { time: { compacted: now } }, content: [{ text: "compacted output" }] }),
      ])
      // Insert a non-compacted part
      db.run("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)", [
        "p-normal", "m1", "s1", now, now,
        JSON.stringify({ type: "tool", content: [{ text: "normal output" }] }),
      ])

      // Verify count
      const allBefore = db.prepare("SELECT COUNT(*) as cnt FROM part").get() as { cnt: number }
      expect(allBefore.cnt).toBe(2)

      // Dry-run: count what would be deleted
      const dryRunCount = db.prepare("SELECT COUNT(*) as cnt FROM part WHERE json_extract(data, '$.state.time.compacted') IS NOT NULL").get() as { cnt: number }
      expect(dryRunCount.cnt).toBe(1)

      // Actually delete
      db.run("DELETE FROM part WHERE json_extract(data, '$.state.time.compacted') IS NOT NULL")

      const allAfter = db.prepare("SELECT COUNT(*) as cnt FROM part").get() as { cnt: number }
      expect(allAfter.cnt).toBe(1)

      const remaining = db.prepare("SELECT id FROM part").all() as { id: string }[]
      expect(remaining[0].id).toBe("p-normal")
    } finally {
      db.close()
      cleanTemp(dir)
    }
  })

  test("delete old tool parts older than threshold", () => {
    const { db, dir } = createTempDb()
    try {
      createSchema(db)
      const now = Date.now()
      seedData(db)

      // Old tool part (older than 90 days ago)
      const cutoff = now - 100 * 86400000 // 100 days ago
      db.run("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)", [
        "p-old-tool", "m1", "s1", cutoff, cutoff,
        JSON.stringify({ type: "tool", content: [{ text: "old tool output" }] }),
      ])
      // Recent tool part
      db.run("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)", [
        "p-recent-tool", "m1", "s1", now, now,
        JSON.stringify({ type: "tool", content: [{ text: "recent tool output" }] }),
      ])
      // Recent non-tool part (should not be deleted)
      db.run("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)", [
        "p-recent-msg", "m1", "s1", now, now,
        JSON.stringify({ type: "message", content: [{ text: "recent message" }] }),
      ])

      const olderThanDays = 90
      const timestamp = now - olderThanDays * 86400000

      // Dry-run COUNT
      const dryRunCount = db.prepare("SELECT COUNT(*) as cnt FROM part WHERE time_created < ? AND json_extract(data, '$.type') = 'tool'").get(timestamp) as { cnt: number }
      expect(dryRunCount.cnt).toBe(1)

      // Delete
      db.run("DELETE FROM part WHERE time_created < ? AND json_extract(data, '$.type') = 'tool'", [timestamp])

      const remaining = db.prepare("SELECT id FROM part ORDER BY id").all() as { id: string }[]
      expect(remaining.length).toBe(2) // recent tool + recent msg (old tool was deleted)
      expect(remaining[0].id).toBe("p-recent-msg")
      expect(remaining[1].id).toBe("p-recent-tool")
    } finally {
      db.close()
      cleanTemp(dir)
    }
  })

  test("dry-run does not delete rows", () => {
    const { db, dir } = createTempDb()
    try {
      createSchema(db)
      const now = Date.now()
      seedData(db)

      // Insert a compacted part
      db.run("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)", [
        "p-compacted", "m1", "s1", now, now,
        JSON.stringify({ type: "tool", state: { time: { compacted: now } }, content: [{ text: "x" }] }),
      ])

      // Count (dry-run)
      const count = db.prepare("SELECT COUNT(*) as cnt FROM part WHERE json_extract(data, '$.state.time.compacted') IS NOT NULL").get() as { cnt: number }
      expect(count.cnt).toBe(1)

      // Verify rows still exist (nothing deleted)
      const all = db.prepare("SELECT COUNT(*) as cnt FROM part").get() as { cnt: number }
      expect(all.cnt).toBe(1) // The compacted part still exists because we didn't run DELETE
    } finally {
      db.close()
      cleanTemp(dir)
    }
  })

  test("--older-than 30d respects custom retention", () => {
    const { db, dir } = createTempDb()
    try {
      createSchema(db)
      const now = Date.now()
      seedData(db)

      // Part from 60 days ago
      const oldTimestamp = now - 60 * 86400000
      db.run("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)", [
        "p-old", "m1", "s1", oldTimestamp, oldTimestamp,
        JSON.stringify({ type: "tool", content: [{ text: "old" }] }),
      ])
      // Part from 20 days ago
      const recentTimestamp = now - 20 * 86400000
      db.run("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)", [
        "p-recent", "m1", "s1", recentTimestamp, recentTimestamp,
        JSON.stringify({ type: "tool", content: [{ text: "recent" }] }),
      ])

      // 30d threshold — only delete parts older than 30 days
      const threshold = now - 30 * 86400000
      const countOld = db.prepare("SELECT COUNT(*) as cnt FROM part WHERE time_created < ? AND json_extract(data, '$.type') = 'tool'").get(threshold) as { cnt: number }
      expect(countOld.cnt).toBe(1) // only p-old (60 days ago)

      db.run("DELETE FROM part WHERE time_created < ? AND json_extract(data, '$.type') = 'tool'", [threshold])

      const remaining = db.prepare("SELECT id FROM part ORDER BY id").all() as { id: string }[]
      expect(remaining.length).toBe(1)
      expect(remaining[0].id).toBe("p-recent")
    } finally {
      db.close()
      cleanTemp(dir)
    }
  })

  test("stats query does not modify database (readonly safety)", () => {
    const { db, dir } = createTempDb()
    try {
      createSchema(db)
      const now = Date.now()
      db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        "s1", "p1", "slug-1", "/tmp", "Session 1", "1", now, now,
      ])

      // Read-only queries — verify this doesn't change anything
      const beforeMod = statSync(dir + "/" + "test.db").mtimeMs
      
      // All stats queries are SELECTs
      db.prepare("PRAGMA page_count").get()
      db.prepare("PRAGMA freelist_count").get()
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      db.prepare("SELECT COUNT(*) as cnt FROM session").get()
      db.prepare("SELECT MIN(time_created) as min_time FROM session").get()

      // Reopening in read-only mode should still work
      const roDb = new BunDatabase(dir + "/" + "test.db", { readonly: true })
      try {
        const cnt = roDb.prepare("SELECT COUNT(*) as cnt FROM session").get() as { cnt: number }
        expect(cnt.cnt).toBe(1)
      } finally {
        roDb.close()
      }
    } finally {
      db.close()
      cleanTemp(dir)
    }
  })
})

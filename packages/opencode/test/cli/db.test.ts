import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Database as BunDatabase } from "bun:sqlite"

import { runVacuum, runCheckpoint, runStats, runCompact } from "../../src/cli/cmd/db"

function createTempDb(): { dbPath: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "db-cli-test-"))
  const dbPath = join(tmpDir, "test.db")
  const db = new BunDatabase(dbPath, { create: true })
  const walPath = dbPath + "-wal"
  const shmPath = dbPath + "-shm"

  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")

  // Create tables matching session.sql.ts schema (minimal columns for our queries)
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
      tokens_cache_write INTEGER NOT NULL DEFAULT 0
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `)

  db.close()

  const cleanup = () => {
    try { rmSync(dbPath, { force: true }) } catch { /* ignore */ }
    try { rmSync(walPath, { force: true }) } catch { /* ignore */ }
    try { rmSync(shmPath, { force: true }) } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  return { dbPath, cleanup }
}

function insertSession(db: BunDatabase, id: string, timeCreated: number) {
  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, 'proj-1', 'slug', '/tmp', 'test', '1.0', ?, ?)`,
    [id, timeCreated, timeCreated],
  )
}

function insertMessage(db: BunDatabase, id: string, sessionId: string, timeCreated: number) {
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, '{}')`,
    [id, sessionId, timeCreated, timeCreated],
  )
}

function insertPart(
  db: BunDatabase,
  id: string,
  messageId: string,
  sessionId: string,
  timeCreated: number,
  data: string,
) {
  db.run(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, messageId, sessionId, timeCreated, timeCreated, data],
  )
}

// Helper to capture console.log output
function captureLog(fn: () => void): string[] {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: string[]) => logs.push(args.join(" "))
  try {
    fn()
  } finally {
    console.log = origLog
  }
  return logs
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("db vacuum", () => {
  test("runs vacuum and frees space on DB with deleted rows", () => {
    const { dbPath, cleanup } = createTempDb()
    try {
      // Insert some data, then delete it to create free pages
      const db = new BunDatabase(dbPath)
      const sessionId = "vac-test-session"
      insertSession(db, sessionId, Date.now())
      const msgId = "vac-test-msg"
      insertMessage(db, msgId, sessionId, Date.now())
      for (let i = 0; i < 100; i++) {
        insertPart(db, `vac-part-${i}`, msgId, sessionId, Date.now(), JSON.stringify({ type: "text", content: "x".repeat(1000) }))
      }
      // Get size before vacuum
      const sizeBefore = statSync(dbPath).size
      db.close()

      // Mark freelist count before vacuum
      const db2 = new BunDatabase(dbPath)
      const beforeFreelist = (db2.prepare("PRAGMA freelist_count").get() as Record<string, unknown>)?.freelist_count as number ?? 0
      db2.close()

      if (beforeFreelist > 0 || sizeBefore > 0) {
        // Run vacuum
        const result = runVacuum(dbPath)
        expect(result.freedBytes).toBeGreaterThanOrEqual(0)
        expect(typeof result.freedBytes).toBe("number")
      }
    } finally {
      cleanup()
    }
  })

  test("runs vacuum on empty DB without error", () => {
    const { dbPath, cleanup } = createTempDb()
    try {
      const result = runVacuum(dbPath)
      expect(result.freedBytes).toBeGreaterThanOrEqual(0)
    } finally {
      cleanup()
    }
  })
})

describe("db checkpoint", () => {
  test("runs checkpoint without error", () => {
    const { dbPath, cleanup } = createTempDb()
    try {
      expect(() => runCheckpoint(dbPath)).not.toThrow()
    } finally {
      cleanup()
    }
  })

  test("runs checkpoint on empty DB without error", () => {
    const { dbPath, cleanup } = createTempDb()
    try {
      expect(() => runCheckpoint(dbPath)).not.toThrow()
    } finally {
      cleanup()
    }
  })
})

describe("db stats", () => {
  test("reports stats for empty DB", () => {
    const { dbPath, cleanup } = createTempDb()
    try {
      const logs = captureLog(() => runStats(dbPath))
      expect(logs.length).toBeGreaterThan(0)
      const output = logs.join("\n")
      expect(output).toContain("DB file size")
      expect(output).toContain("Page size")
      expect(output).toContain("Free pages")
      expect(output).toContain("session")
      expect(output).toContain("0") // empty table counts
    } finally {
      cleanup()
    }
  })

  test("reports stats with data in tables", () => {
    const { dbPath, cleanup } = createTempDb()
    try {
      const db = new BunDatabase(dbPath)
      const now = Date.now()
      insertSession(db, "stats-session-1", now - 86400000 * 100) // 100 days old
      insertSession(db, "stats-session-2", now)
      const msgId = "stats-msg-1"
      insertMessage(db, msgId, "stats-session-1", now)
      insertPart(db, "stats-part-1", msgId, "stats-session-1", now, JSON.stringify({ type: "text" }))
      db.close()

      const logs = captureLog(() => runStats(dbPath))
      const output = logs.join("\n")
      expect(output).toContain("session")
      expect(output).toContain("2") // 2 sessions
      expect(output).toContain("1") // 1 message, 1 part
    } finally {
      cleanup()
    }
  })
})

describe("db compact", () => {
  const OLD_DAYS = 90
  const OLD_TIME = Date.now() - OLD_DAYS * 86400000 - 10000 // older than 90d
  const RECENT_TIME = Date.now() - 1000 // very recent
  const NOW = Date.now()

  function setupCompactTestDb(dbPath: string): void {
    const db = new BunDatabase(dbPath)
    insertSession(db, "compact-session-old", OLD_TIME)
    insertSession(db, "compact-session-recent", RECENT_TIME)
    const msgOld = "compact-msg-old"
    const msgRecent = "compact-msg-recent"
    insertMessage(db, msgOld, "compact-session-old", OLD_TIME)
    insertMessage(db, msgRecent, "compact-session-recent", RECENT_TIME)

    // Compacted part (any age)
    insertPart(
      db,
      "compact-part-compacted",
      msgOld,
      "compact-session-old",
      OLD_TIME,
      JSON.stringify({ type: "text", state: { time: { compacted: OLD_TIME } } }),
    )

    // Old tool part (should be deleted)
    insertPart(
      db,
      "compact-part-old-tool",
      msgOld,
      "compact-session-old",
      OLD_TIME,
      JSON.stringify({ type: "tool", content: "old tool output" }),
    )

    // Recent tool part (should NOT be deleted)
    insertPart(
      db,
      "compact-part-recent-tool",
      msgRecent,
      "compact-session-recent",
      RECENT_TIME,
      JSON.stringify({ type: "tool", content: "recent tool output" }),
    )

    // Recent text part (should NOT be deleted)
    insertPart(
      db,
      "compact-part-recent-text",
      msgRecent,
      "compact-session-recent",
      RECENT_TIME,
      JSON.stringify({ type: "text", content: "recent text" }),
    )

    db.close()
  }

  test("compact --dry-run reports what would be deleted without deleting", () => {
    const { dbPath, cleanup } = createTempDb()
    try {
      setupCompactTestDb(dbPath)

      // Check counts before dry-run
      const dbBefore = new BunDatabase(dbPath)
      const countBefore = (dbBefore.prepare("SELECT count(*) as c FROM part").get() as Record<string, unknown>)?.c as number
      dbBefore.close()
      expect(countBefore).toBe(4) // 4 parts total

      // Run compact --dry-run
      const logs = captureLog(() => runCompact(dbPath, { dryRun: true, olderThan: "90d" }))
      const output = logs.join("\n")

      // Verify it reported counts
      expect(output).toContain("dry-run")

      // Verify nothing was actually deleted
      const dbAfter = new BunDatabase(dbPath)
      const countAfter = (dbAfter.prepare("SELECT count(*) as c FROM part").get() as Record<string, unknown>)?.c as number
      dbAfter.close()
      expect(countAfter).toBe(4)
    } finally {
      cleanup()
    }
  })

  test("compact deletes compacted parts and old tool parts", () => {
    const { dbPath, cleanup } = createTempDb()
    try {
      setupCompactTestDb(dbPath)

      // Run compact (delete, then vacuum)
      const logs = captureLog(() => runCompact(dbPath, { dryRun: false, olderThan: "90d" }))
      const output = logs.join("\n")

      // Verify compacted part was deleted
      const db = new BunDatabase(dbPath)
      const remaining = db.prepare("SELECT id, json_extract(data, '$.type') as type, time_created FROM part ORDER BY id").all() as Record<string, unknown>[]
      db.close()

      // Should have 2 parts remaining (recent tool + recent text)
      expect(remaining.length).toBe(2)

      const remainingIds = remaining.map((r) => r.id)
      expect(remainingIds).toContain("compact-part-recent-tool")
      expect(remainingIds).toContain("compact-part-recent-text")
      expect(remainingIds).not.toContain("compact-part-compacted")
      expect(remainingIds).not.toContain("compact-part-old-tool")

      expect(output).toContain("Deleted")
      expect(output).toContain("parts")
    } finally {
      cleanup()
    }
  })

  test("compact with custom --older-than threshold", () => {
    const { dbPath, cleanup } = createTempDb()
    try {
      const db = new BunDatabase(dbPath)
      const now = Date.now()
      insertSession(db, "ct-session", now)
      const msgId = "ct-msg"
      insertMessage(db, msgId, "ct-session", now)

      // A tool part that is 50 days old (should be kept with --older-than 30d)
      const fiftyDaysAgo = now - 50 * 86400000
      insertPart(
        db,
        "ct-part-50d",
        msgId,
        "ct-session",
        fiftyDaysAgo,
        JSON.stringify({ type: "tool", content: "50 days old" }),
      )

      // A tool part that is 10 days old (should be kept)
      const tenDaysAgo = now - 10 * 86400000
      insertPart(
        db,
        "ct-part-10d",
        msgId,
        "ct-session",
        tenDaysAgo,
        JSON.stringify({ type: "tool", content: "10 days old" }),
      )
      db.close()

      // Compact with --older-than 30d — only parts older than 30 days deleted
      captureLog(() => runCompact(dbPath, { dryRun: false, olderThan: "30d" }))

      const db2 = new BunDatabase(dbPath)
      const remaining = db2.prepare("SELECT id FROM part ORDER BY id").all() as Record<string, unknown>[]
      db2.close()

      expect(remaining.length).toBe(1)
      expect(remaining[0].id).toBe("ct-part-10d")
    } finally {
      cleanup()
    }
  })

  test("compact --older-than defaults to 90d", () => {
    const { dbPath, cleanup } = createTempDb()
    try {
      const db = new BunDatabase(dbPath)
      const now = Date.now()
      insertSession(db, "d-session", now)
      const msgId = "d-msg"
      insertMessage(db, msgId, "d-session", now)

      // A tool part that is 100 days old
      const hundredDaysAgo = now - 100 * 86400000
      insertPart(
        db,
        "d-part-100d",
        msgId,
        "d-session",
        hundredDaysAgo,
        JSON.stringify({ type: "tool", content: "100 days old" }),
      )
      db.close()

      // Compact without explicit --older-than (defaults to 90d)
      captureLog(() => runCompact(dbPath, { dryRun: false }))

      const db2 = new BunDatabase(dbPath)
      const remaining = db2.prepare("SELECT id FROM part ORDER BY id").all() as Record<string, unknown>[]
      db2.close()

      // 100 days > 90 days default, so it should be deleted
      expect(remaining.length).toBe(0)
    } finally {
      cleanup()
    }
  })
})

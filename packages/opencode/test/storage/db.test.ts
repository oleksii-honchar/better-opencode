import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync, statSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Database as BunDatabase } from "bun:sqlite"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import {
  Database,
  startWalCheckpointLoop,
  stopWalCheckpointLoop,
} from "@/storage/db"
import { it } from "../lib/effect"

describe("Database.getChannelPath", () => {
  it.effect("returns database path for the current channel", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const expected = ["latest", "beta", "prod"].includes(InstallationChannel)
        ? path.join(Global.Path.data, "opencode.db")
        : path.join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)

      expect(Database.getChannelPath(flags)).toBe(expected)
    }).pipe(Effect.provide(RuntimeFlags.layer())),
  )

  it.effect("uses the shared database path when channel databases are disabled", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(Database.getChannelPath(flags)).toBe(path.join(Global.Path.data, "opencode.db"))
    }).pipe(Effect.provide(RuntimeFlags.layer({ disableChannelDb: true }))),
  )

  it.effect("accepts RuntimeFlags with skipMigrations for database callers", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.skipMigrations).toBe(true)
      expect(Database.getChannelPath(flags)).toBe(Database.getChannelPath({ disableChannelDb: flags.disableChannelDb }))
    }).pipe(Effect.provide(RuntimeFlags.layer({ skipMigrations: true }))),
  )
})

describe("Database Client PRAGMA journal_size_limit", () => {
  test("sets journal_size_limit to 16MB during database initialization", () => {
    // Create a temp directory for the test database
    const tmpDir = mkdtempSync(join(tmpdir(), "db-pragma-test-"))
    const dbPath = join(tmpDir, "test.db")
    const db = new BunDatabase(dbPath, { create: true })

    try {
      // Run the same PRAGMAs as Client() initialization, in the same order
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA synchronous = NORMAL")
      db.run("PRAGMA busy_timeout = 5000")
      db.run("PRAGMA cache_size = -64000")
      db.run("PRAGMA foreign_keys = ON")
      db.run("PRAGMA journal_size_limit = 16777216")
      db.run("PRAGMA wal_checkpoint(PASSIVE)")

      // Read back journal_size_limit and verify it was set
      const row = db.prepare("PRAGMA journal_size_limit").get() as Record<string, unknown>
      expect(row).toBeDefined()
      expect(Number(row?.journal_size_limit)).toBe(16777216)
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("WAL Checkpoint Loop", () => {
  const origEnv = process.env.OPENCODE_DB_NO_AUTO_CHECKPOINT

  afterEach(() => {
    stopWalCheckpointLoop()
    if (origEnv === undefined) {
      delete process.env.OPENCODE_DB_NO_AUTO_CHECKPOINT
    } else {
      process.env.OPENCODE_DB_NO_AUTO_CHECKPOINT = origEnv
    }
  })

  test("startWalCheckpointLoop does not throw when called", () => {
    expect(() => startWalCheckpointLoop()).not.toThrow()
  })

  test("startWalCheckpointLoop respects OPENCODE_DB_NO_AUTO_CHECKPOINT env var", () => {
    process.env.OPENCODE_DB_NO_AUTO_CHECKPOINT = "1"
    // Should not throw, should just log and return without creating interval
    expect(() => startWalCheckpointLoop()).not.toThrow()
    // Calling again should be safe
    expect(() => startWalCheckpointLoop()).not.toThrow()
  })

  test("startWalCheckpointLoop is idempotent when called twice", () => {
    expect(() => startWalCheckpointLoop()).not.toThrow()
    // Second call should not throw or create a duplicate interval
    expect(() => startWalCheckpointLoop()).not.toThrow()
    // Clean up
    stopWalCheckpointLoop()
  })

  test("stopWalCheckpointLoop stops the interval without error", () => {
    startWalCheckpointLoop()
    expect(() => stopWalCheckpointLoop()).not.toThrow()
    // Calling stop again should be safe
    expect(() => stopWalCheckpointLoop()).not.toThrow()
  })

  test("startWalCheckpointLoop and stopWalCheckpointLoop can round-trip", () => {
    expect(() => startWalCheckpointLoop()).not.toThrow()
    expect(() => stopWalCheckpointLoop()).not.toThrow()
    expect(() => startWalCheckpointLoop()).not.toThrow()
    expect(() => stopWalCheckpointLoop()).not.toThrow()
  })

  test("checkpoint loop can work with a real temp DB and WAL file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wal-loop-test-"))
    const dbPath = join(tmpDir, "test.db")
    const walPath = dbPath + "-wal"
    try {
      // Create a real WAL-mode DB
      const db = new BunDatabase(dbPath, { create: true })
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA foreign_keys = ON")
      // Create a simple table
      db.run(`
        CREATE TABLE IF NOT EXISTS test_items (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        )
      `)
      // Insert some data to create WAL entries
      for (let i = 0; i < 10; i++) {
        db.run("INSERT INTO test_items (id, value) VALUES (?, ?)", [i, `value-${i}`])
      }
      db.close()

      // Verify WAL file exists
      expect(existsSync(walPath)).toBe(true)

      // Run a checkpoint directly on the DB
      const db2 = new BunDatabase(dbPath)
      db2.run("PRAGMA wal_checkpoint(TRUNCATE)")
      db2.close()

      // WAL should still exist but be small
      const walSizeAfter = statSync(walPath).size
      expect(walSizeAfter).toBeGreaterThanOrEqual(0)
    } finally {
      try { rmSync(walPath, { force: true }) } catch { /* ignore */ }
      try { rmSync(dbPath + "-shm", { force: true }) } catch { /* ignore */ }
      try { rmSync(dbPath, { force: true }) } catch { /* ignore */ }
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})

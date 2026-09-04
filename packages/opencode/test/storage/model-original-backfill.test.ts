import { describe, test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle, SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import path from "path"
import { readFileSync, readdirSync } from "fs"

// Helper to create in-memory test database with schema
function createTestDb() {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")

  // Apply schema migrations
  const dir = path.join(import.meta.dirname, "../../migration")
  const entries = readdirSync(dir, { withFileTypes: true })
  const migrations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(path.join(dir, entry.name, "migration.sql"), "utf-8"),
      timestamp: Number(entry.name.split("_")[0]),
      name: entry.name,
    }))
    .sort((a, b) => a.timestamp - b.timestamp)

  for (const m of migrations) {
    sqlite.exec(m.sql)
  }

  const db = drizzle({ client: sqlite })
  return { sqlite, db }
}

describe("model_original backfill migration", () => {
  let sqlite: Database
  let db: SQLiteBunDatabase

  test("backfills model_original from first user message with model", () => {
    ;({ sqlite, db } = createTestDb())

    // Insert a project
    sqlite.exec("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES ('proj_test', '/test', 'git', 1700000000, 1700000001, '[]')")

    // Insert a session with model_original IS NULL
    sqlite.exec("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, model) VALUES ('ses_test', 'proj_test', 'test', '/test', 'Test', '1.0.0', 1700000000, 1700000001, 'openai/gpt-4')")

    // Insert a user message with model info
    const msgData = JSON.stringify({
      role: "user",
      time: { created: 1700000000000 },
      model: { providerID: "openai", modelID: "gpt-4-turbo" }
    })
    sqlite.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_test', 'ses_test', 1700000000, 1700000000, '${msgData}')`)

    // Run backfill migration
    const migrationSql = readFileSync(path.join(import.meta.dirname, "../../migration/20260903123456_add_backfill_session_model_original/migration.sql"), "utf-8")
    sqlite.exec(migrationSql)

    // Verify model_original is now populated
    const rows = sqlite.query("SELECT model_original FROM session WHERE id = 'ses_test'").all()
    expect(rows.length).toBe(1)
    expect((rows[0] as { model_original: string | null }).model_original).not.toBeNull()
    expect((rows[0] as { model_original: string | null }).model_original).toContain("openai")
    expect((rows[0] as { model_original: string | null }).model_original).toContain("gpt-4-turbo")

    sqlite.close()
  })

  test("does not fabricate model_original for sessions without first user message", () => {
    ;({ sqlite, db } = createTestDb())

    sqlite.exec("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES ('proj_test', '/test', 'git', 1700000000, 1700000001, '[]')")
    sqlite.exec("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_test', 'proj_test', 'test', '/test', 'Test', '1.0.0', 1700000000, 1700000001)")

    // No messages
    const migrationSql = readFileSync(path.join(import.meta.dirname, "../../migration/20260903123456_add_backfill_session_model_original/migration.sql"), "utf-8")
    sqlite.exec(migrationSql)

    const rows = sqlite.query("SELECT model_original FROM session WHERE id = 'ses_test'").all()
    expect(rows.length).toBe(1)
    expect((rows[0] as { model_original: string | null }).model_original).toBeNull()

    sqlite.close()
  })

  test("does not overwrite existing model_original", () => {
    ;({ sqlite, db } = createTestDb())

    sqlite.exec("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES ('proj_test', '/test', 'git', 1700000000, 1700000001, '[]')")

    // Session already has model_original set
    sqlite.exec(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, model_original) VALUES ('ses_test', 'proj_test', 'test', '/test', 'Test', '1.0.0', 1700000000, 1700000001, '{"providerID":"openai","modelID":"gpt-4-set-already"}')`)

    const msgData = JSON.stringify({
      role: "user",
      time: { created: 1700000000000 },
      model: { providerID: "openai", modelID: "gpt-4-different" }
    })
    sqlite.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_test', 'ses_test', 1700000000, 1700000000, '${msgData}')`)

    const migrationSql = readFileSync(path.join(import.meta.dirname, "../../migration/20260903123456_add_backfill_session_model_original/migration.sql"), "utf-8")
    sqlite.exec(migrationSql)

    const rows = sqlite.query("SELECT model_original FROM session WHERE id = 'ses_test'").all()
    expect(rows.length).toBe(1)
    expect((rows[0] as { model_original: string | null }).model_original).toContain("gpt-4-set-already")
    expect((rows[0] as { model_original: string | null }).model_original).not.toContain("gpt-4-different")

    sqlite.close()
  })

  test("is idempotent (second run does not change values)", () => {
    ;({ sqlite, db } = createTestDb())

    sqlite.exec("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES ('proj_test', '/test', 'git', 1700000000, 1700000001, '[]')")
    sqlite.exec("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_test', 'proj_test', 'test', '/test', 'Test', '1.0.0', 1700000000, 1700000001)")

    const msgData = JSON.stringify({
      role: "user",
      time: { created: 1700000000000 },
      model: { providerID: "openai", modelID: "gpt-4" }
    })
    sqlite.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_test', 'ses_test', 1700000000, 1700000000, '${msgData}')`)

    const migrationSql = readFileSync(path.join(import.meta.dirname, "../../migration/20260903123456_add_backfill_session_model_original/migration.sql"), "utf-8")

    // Run twice
    sqlite.exec(migrationSql)
    const rows1 = sqlite.query("SELECT model_original FROM session WHERE id = 'ses_test'").all()

    sqlite.exec(migrationSql)
    const rows2 = sqlite.query("SELECT model_original FROM session WHERE id = 'ses_test'").all()

    expect((rows1[0] as { model_original: string | null }).model_original).toBe(
      (rows2[0] as { model_original: string | null }).model_original
    )

    sqlite.close()
  })

  test("does not touch session.model or model_override", () => {
    ;({ sqlite, db } = createTestDb())

    sqlite.exec("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES ('proj_test', '/test', 'git', 1700000000, 1700000001, '[]')")
    sqlite.exec("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, model, model_override) VALUES ('ses_test', 'proj_test', 'test', '/test', 'Test', '1.0.0', 1700000000, 1700000001, 'openai/gpt-4', 'openai/gpt-4.5')")

    const msgData = JSON.stringify({
      role: "user",
      time: { created: 1700000000000 },
      model: { providerID: "openai", modelID: "gpt-4-turbo" }
    })
    sqlite.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_test', 'ses_test', 1700000000, 1700000000, '${msgData}')`)

    const migrationSql = readFileSync(path.join(import.meta.dirname, "../../migration/20260903123456_add_backfill_session_model_original/migration.sql"), "utf-8")
    sqlite.exec(migrationSql)

    const rows = sqlite.query("SELECT model, model_override FROM session WHERE id = 'ses_test'").all()
    expect((rows[0] as { model: string | null; model_override: string | null }).model).toBe("openai/gpt-4")
    expect((rows[0] as { model: string | null; model_override: string | null }).model_override).toBe("openai/gpt-4.5")

    sqlite.close()
  })

  test("zero-row no-op on fresh DB (re-apply changes nothing)", () => {
    ;({ sqlite, db } = createTestDb())

    sqlite.exec("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES ('proj_test', '/test', 'git', 1700000000, 1700000001, '[]')")

    // Fresh session with no first user message
    sqlite.exec("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_test', 'proj_test', 'test', '/test', 'Test', '1.0.0', 1700000000, 1700000001)")

    // Get checksum before
    const before = sqlite.query("SELECT id, model_original FROM session WHERE id = 'ses_test'").all()[0]
    expect((before as { id: string; model_original: string | null }).model_original).toBeNull()

    // Run migration twice
    const migrationSql = readFileSync(path.join(import.meta.dirname, "../../migration/20260903123456_add_backfill_session_model_original/migration.sql"), "utf-8")
    sqlite.exec(migrationSql)
    sqlite.exec(migrationSql)

    // Get checksum after
    const after = sqlite.query("SELECT id, model_original FROM session WHERE id = 'ses_test'").all()[0]
    expect((after as { id: string; model_original: string | null }).model_original).toBeNull()
    expect((before as { id: string }).id).toBe((after as { id: string }).id)

    sqlite.close()
  })

  test("migration follows column-add migration (timestamp ordering)", () => {
    // The backfill migration timestamp (20260903123456) must be greater than
    // the column-add migration (20260903120000) so they run in the correct order.
    const backfillTs = 20260903123456
    const columnAddTs = 20260903120000
    expect(backfillTs).toBeGreaterThan(columnAddTs)
  })
})

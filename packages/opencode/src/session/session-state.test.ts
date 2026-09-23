import { describe, it, expect, beforeEach } from "vitest"
import { Effect } from "effect"
import { drizzle, betterSqlite3 } from "drizzle-orm/better-sqlite3"
import { Database } from "../storage/database"
import { SessionMetadataTable } from "./session-metadata.sql"
import { SessionMetadataService } from "./session-metadata"

describe("SessionMetadataService", () => {
  let db: any

  beforeEach(async () => {
    const sqlite = betterSqlite3(":memory:")
    db = drizzle(sqlite, { schema: { SessionMetadataTable } })
    await db.execute("PRAGMA foreign_keys = ON")
    await db.execute(`
      CREATE TABLE session_metadata (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        time_created INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        time_updated INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (session_id, key)
      )
    `)
  })

  it("should set a key-value pair", async () => {
    const result = await Effect.runPromise(
      SessionMetadataService.set("session-1", "anchor_node", "node-123")
    )
    expect(result).toBeDefined()
  })

  it("should get a value by key", async () => {
    await Effect.runPromise(SessionMetadataService.set("session-1", "anchor_node", "node-123"))
    const value = await Effect.runPromise(SessionMetadataService.get("session-1", "anchor_node"))
    expect(value).toBe("node-123")
  })

  it("should return null for non-existent key", async () => {
    const value = await Effect.runPromise(SessionMetadataService.get("session-1", "missing"))
    expect(value).toBeUndefined()
  })

  it("should get all metadata for a session", async () => {
    await Effect.runPromise(SessionMetadataService.set("session-1", "key1", "value1"))
    await Effect.runPromise(SessionMetadataService.set("session-1", "key2", "value2"))
    const all = await Effect.runPromise(SessionMetadataService.getAll("session-1"))
    expect(all).toHaveLength(2)
    expect(all.find((m) => m.key === "key1")?.value).toBe("value1")
    expect(all.find((m) => m.key === "key2")?.value).toBe("value2")
  })

  it("should update an existing key (upsert)", async () => {
    await Effect.runPromise(SessionMetadataService.set("session-1", "anchor_node", "node-old"))
    await Effect.runPromise(SessionMetadataService.set("session-1", "anchor_node", "node-new"))
    const value = await Effect.runPromise(SessionMetadataService.get("session-1", "anchor_node"))
    expect(value).toBe("node-new")
  })

  it("should delete a key", async () => {
    await Effect.runPromise(SessionMetadataService.set("session-1", "key1", "value1"))
    await Effect.runPromise(SessionMetadataService.delete("session-1", "key1"))
    const value = await Effect.runPromise(SessionMetadataService.get("session-1", "key1"))
    expect(value).toBeUndefined()
  })

  it("should not return keys from other sessions", async () => {
    await Effect.runPromise(SessionMetadataService.set("session-1", "key1", "value1"))
    await Effect.runPromise(SessionMetadataService.set("session-2", "key1", "value2"))
    const all = await Effect.runPromise(SessionMetadataService.getAll("session-1"))
    expect(all).toHaveLength(1)
    expect(all[0].value).toBe("value1")
  })
})
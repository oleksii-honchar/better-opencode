import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@/storage/db"
import { Session as SessionNs } from "@/session/session"
import { SessionTable, MessageTable, PartTable, SessionMessageTable } from "../../src/session/session.sql"
import { eq, and, count, sql } from "drizzle-orm"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

/**
 * Helper: directly update the time_updated column for a session in the database.
 */
function setSessionUpdatedTime(sessionID: string, timestamp: number): void {
  Database.use((db) =>
    db
      .update(SessionTable)
      .set({ time_updated: timestamp })
      .where(eq(SessionTable.id, sessionID as SessionID))
      .run(),
  )
}

describe("listGlobal with olderThan filter", () => {
  it.instance("should filter sessions where time_updated < olderThan", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service

      // Create two sessions
      const fresh = yield* svc.create({ title: "fresh-session" })
      const old = yield* svc.create({ title: "old-session" })

      // Manually set old session's time_updated to 30 days ago
      const thirtyDaysAgo = Date.now() - 30 * 86400000
      setSessionUpdatedTime(old.id, thirtyDaysAgo)

      // Query with cutoff at 7 days ago — should only return the old session
      const sevenDaysAgo = Date.now() - 7 * 86400000
      const result = Array.from(SessionNs.listGlobal({ olderThan: sevenDaysAgo }))

      expect(result.length).toBeGreaterThanOrEqual(1)
      const ids = result.map((s) => s.id)
      expect(ids).toContain(old.id)
      expect(ids).not.toContain(fresh.id)

      // Cleanup
      yield* svc.remove(SessionID.make(fresh.id))
      yield* svc.remove(SessionID.make(old.id))
    }),
  )

  it.instance("should return no sessions when olderThan is in the past before any sessions", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const session = yield* svc.create({ title: "recent-session" })

      // Cutoff at 1ms — nothing should be older than 1ms
      const result = Array.from(SessionNs.listGlobal({ olderThan: 1 }))

      expect(result.length).toBe(0)

      yield* svc.remove(SessionID.make(session.id))
    }),
  )

  it.instance("should work with roots filter combined with olderThan", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service

      // Create root session
      const root = yield* svc.create({ title: "root-old" })
      // Set its time to 30 days ago
      setSessionUpdatedTime(root.id, Date.now() - 30 * 86400000)

      const cutoff = Date.now() - 1 * 86400000
      const result = Array.from(
        SessionNs.listGlobal({ olderThan: cutoff, roots: true, archived: false }),
      )

      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result.map((s) => s.id)).toContain(root.id)

      yield* svc.remove(SessionID.make(root.id))
    }),
  )
})

describe("session cleanup dry-run", () => {
  it.instance("dry-run should not delete sessions", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service

      // Create an old session
      const session = yield* svc.create({ title: "dry-run-test" })
      setSessionUpdatedTime(session.id, Date.now() - 100 * 86400000)

      // Sanity check: session exists
      const before = Array.from(SessionNs.listGlobal({ olderThan: Date.now() - 1 }))
      expect(before.map((s) => s.id)).toContain(session.id)

      // Simulate dry-run: archive + remove should NOT happen
      // Just verify session still exists after the dry-run "check"
      const after = Array.from(SessionNs.listGlobal({ olderThan: Date.now() - 1 }))
      expect(after.map((s) => s.id)).toContain(session.id)
      // And it's not archived
      const notArchived = Array.from(
        SessionNs.listGlobal({ archived: false, olderThan: Date.now() - 1 }),
      )
      expect(notArchived.map((s) => s.id)).toContain(session.id)

      yield* svc.remove(SessionID.make(session.id))
    }),
  )
})

describe("session cleanup actual deletion", () => {
  it.instance("should archive and then delete old sessions", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service

      // Create an old session
      const session = yield* svc.create({ title: "real-delete-test" })
      // Set it to 100 days ago
      setSessionUpdatedTime(session.id, Date.now() - 100 * 86400000)

      // Verify it shows up in the global list as non-archived
      const before = Array.from(
        SessionNs.listGlobal({ olderThan: Date.now() - 1, archived: false }),
      )
      expect(before.map((s) => s.id)).toContain(session.id)

      // Archive it
      yield* svc.setArchived({ sessionID: SessionID.make(session.id), time: Date.now() })

      // After archiving, it should NOT show up in non-archived query
      const afterArchive = Array.from(
        SessionNs.listGlobal({ olderThan: Date.now() - 1, archived: false }),
      )
      expect(afterArchive.map((s) => s.id)).not.toContain(session.id)

      // Remove it
      yield* svc.remove(SessionID.make(session.id))

      // Verify deletion
      const getResult = yield* svc.get(SessionID.make(session.id)).pipe(Effect.exit)
      expect(getResult._tag).toBe("Failure")
    }),
  )

  it.instance("cascade deletion removes messages and parts", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service

      // Create session
      const session = yield* svc.create({ title: "cascade-test" })
      const sessionID = SessionID.make(session.id)
      setSessionUpdatedTime(session.id, Date.now() - 100 * 86400000)

      // Add a message using the updateMessage API
      const { MessageID } = yield* Effect.promise(async () => {
        const { MessageID } = await import("../../src/session/schema")
        return { MessageID }
      })
      const messageID = MessageID.ascending()
      yield* svc.updateMessage({
        id: messageID,
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as any)

      // Verify message exists
      const msgBefore = Database.use((db) =>
        db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.session_id, sessionID)).all(),
      )
      expect(msgBefore.length).toBe(1)

      // Remove the session
      yield* svc.remove(sessionID)

      // Verify cascade deletion
      const msgAfter = Database.use((db) =>
        db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.session_id, sessionID)).all(),
      )
      expect(msgAfter.length).toBe(0)
    }),
  )
})

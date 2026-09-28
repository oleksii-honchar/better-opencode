import { Effect } from "effect"
import { Database } from "@/storage/db"
import { SessionMetadataTable } from "./session-state.sql"
import { eq, and } from "drizzle-orm"

export const listAll = (sessionID: string) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(SessionMetadataTable)
        .where(eq(SessionMetadataTable.session_id, sessionID))
        .all(),
    ),
  ).pipe(Effect.map((rows) => rows.map((r) => ({ key: r.key, value: r.value }))))

export const get = (sessionID: string, key: string) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(SessionMetadataTable)
        .where(and(eq(SessionMetadataTable.session_id, sessionID), eq(SessionMetadataTable.key, key)))
        .get(),
    ),
  ).pipe(Effect.map((row) => (row ? { key: row.key, value: row.value } : null)))

export const set = (sessionID: string, key: string, value: string) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .insert(SessionMetadataTable)
        .values({ session_id: sessionID, key, value })
        .onConflictDoUpdate({
          target: [SessionMetadataTable.session_id, SessionMetadataTable.key],
          set: { value },
        })
        .run(),
    ),
  )

export const remove = (sessionID: string, key: string) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .delete(SessionMetadataTable)
        .where(and(eq(SessionMetadataTable.session_id, sessionID), eq(SessionMetadataTable.key, key)))
        .run(),
    ),
  )
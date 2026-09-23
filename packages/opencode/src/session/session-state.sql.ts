import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./session.sql"
import { Timestamps } from "../storage/schema.sql"

export const SessionMetadataTable = sqliteTable(
  "session_metadata",
  {
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    key: text().notNull(),
    value: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.key] }),
  ],
)
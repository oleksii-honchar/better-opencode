import z from "zod"
import { openInspectorDb } from "./db"
import type { Database } from "bun:sqlite"

// GET /session-inspector/sessions — the sidebar feed (§5.1-1): straight rows
// from the engine's `session` table through the Task-2 read-only seam
// (openInspectorDb — the same function tests assert write-throw + byte-identity
// on; the inspector never creates or migrates a database).
//
// The parent tree is NOT assembled server-side: rows carry `parent_id` and the
// client groups (§5.1-1). Internal errors return as values (Result-style) — the
// request handler wrapper never sees a throw.

export const SESSIONS_LIMIT_DEFAULT = 100
export const SESSIONS_LIMIT_MAX = 500

const FeedQuerySchema = z.object({
  q: z.string().min(1).max(1024).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .transform((n) => Math.min(Math.trunc(n), SESSIONS_LIMIT_MAX))
    .default(SESSIONS_LIMIT_DEFAULT),
})
export type SessionsFeedQuery = z.infer<typeof FeedQuerySchema>

const norm = (value: string | null): string | undefined => {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

export type FeedQueryResult = { ok: true; value: SessionsFeedQuery } | { ok: false; issues: string[] }

export function parseSessionsFeedQuery(params: URLSearchParams): FeedQueryResult {
  const parsed = FeedQuerySchema.safeParse({ q: norm(params.get("q")), limit: norm(params.get("limit")) })
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`) }
  }
  return { ok: true, value: parsed.data }
}

// SQL LIKE with user input made literal: %, _ and \ are escaped (ESCAPE '\').
const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export interface SessionFeedRow {
  id: string
  title: string
  agent: string | null
  time_created: number
  time_updated: number
  parent_id: string | null
  cost: number
}

export type FeedRowsResult = { ok: true; rows: SessionFeedRow[] } | { ok: false; message: string }

const FEED_SQL = `SELECT id, title, agent, time_created, time_updated, parent_id, cost
FROM session
WHERE (? IS NULL OR title LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')
ORDER BY time_updated DESC, id DESC
LIMIT ?`

export function sessionFeedRows(input: { dbPath: string; q: string | undefined; limit: number | undefined }): FeedRowsResult {
  let db: Database
  try {
    db = openInspectorDb(input.dbPath)
  } catch (error) {
    return {
      ok: false,
      message:
        `The session inspector could not open the engine database at ${input.dbPath}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `The inspector only reads the database — start the engine once (or point paths.dbMode at an existing database file).`,
    }
  }
  try {
    const pattern = input.q === undefined ? null : likePattern(input.q)
    const rows = db
      .query<SessionFeedRow, (string | number | null)[]>(FEED_SQL)
      .all(pattern, pattern, pattern, input.limit ?? SESSIONS_LIMIT_DEFAULT)
    return { ok: true, rows }
  } catch (error) {
    return {
      ok: false,
      message: `The session inspector could not read the session table from ${input.dbPath}: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    }
  } finally {
    db.close()
  }
}

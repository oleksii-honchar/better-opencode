import path from "node:path"
import z from "zod"
import { openInspectorDb } from "./db"
import type { Database } from "bun:sqlite"
import { SCAN_DEPTH_LIMIT, scanRecordForFolder } from "./session-scan"
import type { ScanIO, ScanRecord } from "./session-scan"

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
// AD42 exports the ONE pattern builder: the folder matcher interprets THIS pattern's
// output (below), so both matchers share a single escaping law by construction.
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

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

// The ONE mapped-column list — FEED_SQL and the AD42 by-id lookup select through this
// constant so the two statements cannot drift when the feed surface changes.
const FEED_COLUMNS = "id, title, agent, time_created, time_updated, parent_id, cost"

const FEED_SQL = `SELECT ${FEED_COLUMNS}
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

// AD42 — folder-name search merged into the feed (owner: a session folder name must be
// searchable when the session id is unknown). Law, in order:
//   1. q absent (or agentsRoot unset): the plain feed path, byte-for-byte — the folder
//      world is never opened (zero FS calls).
//   2. q present: folder NAMES under agentsRoot are matched FIRST (the name filter is
//      the gate); the matcher interprets likePattern's OWN output — the same escaping
//      law as FEED_SQL, shared by construction, never a second regex.
//   3. Only name-matched dirs get content reads (session.md/history.jsonl) — bounded
//      even in deep worlds; resolution is that folder's frontmatter sessionId.
//   4. The merged response: full DB row when the engine DB has the session (it joins
//      the SAME comparator as FEED_SQL — time_updated DESC, id DESC); otherwise the
//      exact scan-route record shape (no invented fields) appended after the DB-form
//      block — it carries no time fields, so it cannot join a time comparator honestly.
//   5. id-based dedup (a session matched twice appears once; DB form wins); limit is
//      honored across the whole response.

export type FeedMergedRow = SessionFeedRow | ScanRecord
export type FeedMergedRowsResult = { ok: true; rows: FeedMergedRow[] } | { ok: false; message: string }

type LikeSegment = { op: "lit"; text: string } | { op: "anyOne" } | { op: "anyMany" }

// Interpret a LIKE pattern built by likePattern under ESCAPE '\': a backslash quotes
// the next character (literal), an unescaped % matches any run, an unescaped _ matches
// exactly one character. This consumes likePattern's output — the ONE pattern builder —
// so the folder matcher cannot drift from the SQL path.
function likeSegmentsFromPattern(pattern: string): LikeSegment[] {
  const segs: LikeSegment[] = []
  const pushLit = (text: string): void => {
    const last = segs[segs.length - 1]
    if (last?.op === "lit") last.text += text
    else segs.push({ op: "lit", text })
  }
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === "\\" && i + 1 < pattern.length) pushLit(pattern[++i]!)
    else if (ch === "%") {
      if (segs[segs.length - 1]?.op !== "anyMany") segs.push({ op: "anyMany" })
    } else if (ch === "_") segs.push({ op: "anyOne" })
    else pushLit(ch)
  }
  return segs
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// likePattern wraps the pattern in %, so matching is substring semantics; the fold is
// the ASCII-insensitive behavior SQLite LIKE has for ASCII text.
const likeNameMatches = (name: string, segs: LikeSegment[]): boolean => {
  const source = segs
    .map((s) => (s.op === "lit" ? escapeRegExp(s.text) : s.op === "anyMany" ? "[\\s\\S]*" : "[\\s\\S]"))
    .join("")
  return new RegExp(source, "i").test(name)
}

// Candidate dirs by NAME only — no file is opened here. The depth cap and sorted
// traversal mirror the scan walk (same world law); session content is read by the
// CALLER for the returned (name-matched) dirs ONLY.
function folderNameCandidates(agentsRoot: string, q: string, io: ScanIO): string[] {
  const segs = likeSegmentsFromPattern(likePattern(q))
  const found: string[] = []
  const visit = (dir: string, depth: number): void => {
    if (depth < 0) return
    if (likeNameMatches(path.basename(dir), segs)) found.push(dir)
    if (depth === 0) return
    const entries = io.readDir(dir)
    if (entries === undefined) return
    for (const name of [...entries].sort()) visit(path.join(dir, name), depth - 1)
  }
  visit(path.resolve(agentsRoot), SCAN_DEPTH_LIMIT)
  return found
}

// The full mapped row for one id, same column list as FEED_SQL, through the same
// read-only seam. undefined = the engine DB has no such session.
function feedRowById(dbPath: string, id: string): SessionFeedRow | undefined {
  const db = openInspectorDb(dbPath)
  try {
    const row = db
      .query<SessionFeedRow, [string]>(
        `SELECT ${FEED_COLUMNS} FROM session WHERE id = ?`,
      )
      .get(id)
    return row ?? undefined
  } finally {
    db.close()
  }
}

// Same comparator as FEED_SQL ORDER BY (time_updated DESC, id DESC; ids are unique).
const byFeedOrder = (a: SessionFeedRow, b: SessionFeedRow): number =>
  b.time_updated - a.time_updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

export function sessionFeedRowsMerged(input: {
  dbPath: string
  q: string | undefined
  limit?: number | undefined
  agentsRoot: string
  io: ScanIO
}): FeedMergedRowsResult {
  const q = input.q !== undefined && input.q.length > 0 ? input.q : undefined
  const limit = input.limit ?? SESSIONS_LIMIT_DEFAULT
  if (q === undefined || input.agentsRoot.trim().length === 0) {
    // q-absent / no roots: VERBATIM the existing path — not a reimplementation.
    return sessionFeedRows({ dbPath: input.dbPath, q: input.q, limit: input.limit })
  }

  const feed = sessionFeedRows({ dbPath: input.dbPath, q, limit })
  if (!feed.ok) return feed

  try {
    const dbRows = [...feed.rows]
    const seen = new Set(dbRows.map((row) => row.id))
    const fallbacks: ScanRecord[] = []
    for (const dir of folderNameCandidates(input.agentsRoot, q, input.io)) {
      // name filter already ran; this is the ONLY place folder content is read.
      const record = scanRecordForFolder(input.io, dir)
      if (record === undefined) continue
      if (seen.has(record.sessionId)) continue // dedup: already present (DB form wins)
      seen.add(record.sessionId)
      const row = feedRowById(input.dbPath, record.sessionId)
      if (row !== undefined) dbRows.push(row)
      else fallbacks.push(record)
    }
    const capped = dbRows.sort(byFeedOrder).slice(0, limit)
    // scan-shaped entries carry no time fields (no invented fields): they join after
    // the DB-form block, in deterministic candidate order, within the remaining room.
    return { ok: true, rows: [...capped, ...fallbacks.slice(0, Math.max(0, limit - capped.length))] }
  } catch (error) {
    return {
      ok: false,
      message: `The session inspector could not read the session table from ${input.dbPath}: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    }
  }
}

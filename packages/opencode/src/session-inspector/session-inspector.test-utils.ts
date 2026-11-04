import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import type { ConfigIO, InspectorBaseDirs } from "./config"
import type { ScanIO } from "./session-scan"

// Shared fixtures for session-inspector unit tests (repo *.test-utils.ts convention).
// Injectable IO per the plan's Test strategy: unit tests never touch the live config dir
// or a live DB file outside temp dirs.

export const GOLDEN_CATEGORY_IDS = [
  "user-messages",
  "assistant-text",
  "reasoning",
  "tool-calls",
  "transitions",
  "pipeline",
  "coach-judge",
  "coach-activity",
  "amt-activity",
  "engine-nudges",
  "lifecycle",
  "other",
] as const

export function tempDirs(): InspectorBaseDirs & { cleanup: () => void; configPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), "session-inspector-"))
  const configDir = path.join(root, "config")
  const agentsDir = path.join(root, "agents")
  const logsDir = path.join(root, "logs")
  mkdirSync(configDir)
  mkdirSync(agentsDir)
  mkdirSync(logsDir)
  return {
    configDir,
    agentsDir,
    logsDir,
    configPath: path.join(configDir, "session-inspector.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** In-memory ConfigIO over a path→text map; paths in `unreadable` report the error kind. */
export function memoryIO(files: Record<string, string>, unreadable: Set<string> = new Set()): ConfigIO {
  return {
    read: (p: string) => {
      if (unreadable.has(p)) return { kind: "error", message: `EACCES: permission denied, open '${p}'` }
      const text = Object.prototype.hasOwnProperty.call(files, p) ? files[p] : undefined
      if (text === undefined) return { kind: "missing" }
      return { kind: "ok", text }
    },
  }
}

/** Minimal non-empty SQLite fixture with a `session` table (row present for read queries). */
export function makeFixtureDb(dbPath: string): void {
  const db = new Database(dbPath, { create: true })
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)")
  db.run("INSERT INTO session (id, title) VALUES ('ses_fixture', 'fixture session')")
  db.close()
}

export function readBytes(p: string): Buffer {
  return readFileSync(p)
}

// ---------------------------------------------------------------------------
// Task 3 fixtures
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.join(import.meta.dirname, "../../migration")

/**
 * Real engine schema, not hand-written DDL: replays the repo's own migration
 * journal (same sort-by-tag algorithm as storage/db.ts migrations()) into a
 * temp DB. Cross-checked by a live-store PRAGMA probe (2026-11-03): 25
 * migrations → the 31-column `session` table of the current store.
 */
export function makeFixtureSessionDb(dbPath: string): void {
  const time = (tag: string): number => {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!m) return 0
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  }
  const entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .map((name) => {
      const file = path.join(MIGRATIONS_DIR, name, "migration.sql")
      if (!existsSync(file)) return undefined
      return { sql: readFileSync(file, "utf8"), timestamp: time(name), name }
    })
    .filter((entry): entry is { sql: string; timestamp: number; name: string } => entry !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp)

  const db = new Database(dbPath, { create: true })
  try {
    for (const entry of entries) db.run(entry.sql)
  } finally {
    db.close()
  }
}

export interface FixtureSessionRow {
  id: string
  title: string
  timeCreated: number
  timeUpdated: number
  agent?: string
  parentId?: string
  cost?: number
}

/** Inserts a session row with the real table's NOT NULL columns filled; others default. */
export function insertSession(dbPath: string, row: FixtureSessionRow): void {
  const db = new Database(dbPath)
  try {
    db.query(
      `INSERT INTO session (id, project_id, slug, directory, title, version, cost, time_created, time_updated, agent, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      "prj_fixture",
      `slug-${row.id}`,
      "/fixture/dir",
      row.title,
      "0.0.0-test",
      row.cost ?? 0,
      row.timeCreated,
      row.timeUpdated,
      row.agent ?? "worker",
      row.parentId ?? null,
    )
  } finally {
    db.close()
  }
}

// -- agent-sessions tree fixtures --------------------------------------------
// Folder names come from the REAL resolver script (compose mode, AGENT_SESSIONS_DIR
// pointed at the temp root) — never hand-composed shapes (worker-notes).

const RESOLVER = path.join(process.env["HOME"] ?? "/Users/tuiteraz", ".config/opencode/agents/scripts/resolve-session-path.mjs")

/** Composes a canonical v2 session folder path under `root` via the real resolver script. */
export function composeSessionFolder(root: string, date: string, time: string, shortname: string): string {
  if (!existsSync(RESOLVER)) throw new Error(`resolver script missing at ${RESOLVER} — cannot compose fixture path (never hand-compose)`)
  const out = execFileSync(process.execPath, [RESOLVER, "compose", "--date", date, "--time", time, "--shortname", shortname], {
    encoding: "utf8",
    env: { ...process.env, AGENT_SESSIONS_DIR: root },
  }).trim()
  return out
}

export interface SessionFolderSpec {
  sessionId: string
  /** omit the frontmatter entirely */
  noFrontmatter?: boolean
  /** frontmatter without a sessionId line */
  badFrontmatter?: boolean
  title?: string
  timeCreated?: string
  /** history file content; default one non-empty line; empty string = file exists, no records */
  history?: string
  /** omit the history file entirely */
  noHistory?: boolean
}

// ---------------------------------------------------------------------------
// Task 4 fixtures — engine message/part rows + v2.3 history lines + judge/tools files
// ---------------------------------------------------------------------------

/** Minimal message row carrying data.role (measured 2026-11-03: role lives in message.data, NOT in part.data). */
export function insertMessage(
  dbPath: string,
  row: { id: string; sessionId: string; timeCreated: number; role: string; agent?: string },
): void {
  const db = new Database(dbPath)
  try {
    db.query(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
      row.id,
      row.sessionId,
      row.timeCreated,
      row.timeCreated,
      JSON.stringify({ role: row.role, agent: row.agent ?? "worker", time: { created: row.timeCreated, updated: row.timeCreated } }),
    )
  } finally {
    db.close()
  }
}

/** Part row; `data` stores exactly JSON.stringify(dataObj) bytes (payload/length assertions depend on that). */
export function insertPart(
  dbPath: string,
  row: { id: string; messageId: string; sessionId: string; timeCreated: number; data: Record<string, unknown> },
): void {
  const db = new Database(dbPath)
  try {
    db.query(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
      row.id,
      row.messageId,
      row.sessionId,
      row.timeCreated,
      row.timeCreated,
      JSON.stringify(row.data),
    )
  } finally {
    db.close()
  }
}

/**
 * One serialized v2.3 history line with EXACTLY the key order and always-present keys of the
 * record builder installed at ~/.config/opencode/agents/scripts/history.mjs
 * (verified by reading its builder source 2026-11-03: ts, sessionId, agent, event, details,
 * nextAgent, phase, status — plus conditional subAgentSessionId/parentSessionId only when the
 * env-derived value is set, parentSessionId only when it differs).
 */
export function historyLine(spec: {
  ts: string
  sessionId: string
  agent: string
  event: string
  details?: string | null
  nextAgent?: string | null
  phase?: string | null
  status?: string | null
  subAgentSessionId?: string
  parentSessionId?: string
}): string {
  const record: Record<string, unknown> = {
    ts: spec.ts,
    sessionId: spec.sessionId,
    agent: spec.agent,
    event: spec.event,
    details: spec.details ?? null,
    nextAgent: spec.nextAgent ?? null,
    phase: spec.phase ?? null,
    status: spec.status ?? null,
  }
  if (spec.subAgentSessionId !== undefined) record.subAgentSessionId = spec.subAgentSessionId
  if (spec.parentSessionId !== undefined) record.parentSessionId = spec.parentSessionId
  return JSON.stringify(record)
}

/** JudgeRecord body in the ADR-0011 §3 fixed field order (v,sid,seq,ts,kind,node,backend,model,request,answer); objects preserve insertion order through JSON.stringify. */
export function judgeRecordV11(r: {
  v: number
  sid: string
  seq: number
  ts: string
  kind: string
  node: string
  backend: string
  model: string | null
  request: unknown
  answer: unknown
  error?: { stage: string; detail: string }
}): string {
  const rec: Record<string, unknown> = {
    v: r.v,
    sid: r.sid,
    seq: r.seq,
    ts: r.ts,
    kind: r.kind,
    node: r.node,
    backend: r.backend,
    model: r.model,
    request: r.request,
    answer: r.answer,
  }
  if (r.error !== undefined) rec.error = r.error
  return JSON.stringify(rec)
}

/** Writes materials/judge-records.jsonl under a session folder from raw line strings. */
export function writeJudgeRecords(sessionFolder: string, lines: string[]): string {
  const dir = path.join(sessionFolder, "materials")
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, "judge-records.jsonl")
  writeFileSync(target, lines.map((l) => l + "\n").join(""))
  return target
}

/** Writes tools.log rotation files under a logs dir: files keyed by base name ("tools.log", "tools-1", ...). */
export function writeToolsLogFiles(logsDir: string, files: Record<string, string[]>): void {
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(path.join(logsDir, name), lines.map((l) => l + "\n").join(""))
  }
}

/** Real-FS ScanIO over node fs (same shape session-scan endpoint uses in production). */
export function nodeScanIO(): ScanIO {
  return {
    readDir: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return undefined
      }
    },
    read: (file) => {
      try {
        return existsSync(file) ? readFileSync(file, "utf8") : undefined
      } catch {
        return undefined
      }
    },
  }
}

/** Writes a session folder (session.md + history.jsonl) inside an existing folder path. */
export function writeSessionFolder(folder: string, spec: SessionFolderSpec): string {
  mkdirSync(folder, { recursive: true })
  const frontmatter = spec.noFrontmatter
    ? "# notes\nno frontmatter here\n"
    : spec.badFrontmatter
      ? `---\ntitle: orphan\n---\n\n# orphan\n`
      : [
          "---",
          `sessionId: ${spec.sessionId}`,
          ...(spec.title !== undefined ? [`title: "${spec.title}"`] : []),
          ...(spec.timeCreated !== undefined ? [`timeCreated: "${spec.timeCreated}"`] : []),
          "---",
          "",
          `# ${spec.title ?? spec.sessionId}`,
        ].join("\n")
  writeFileSync(path.join(folder, "session.md"), frontmatter)
  if (!spec.noHistory) writeFileSync(path.join(folder, "history.jsonl"), spec.history ?? `${JSON.stringify({ note: "one record" })}\n`)
  return folder
}

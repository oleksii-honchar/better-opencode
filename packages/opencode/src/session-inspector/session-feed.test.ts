import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import path from "path"
import { HttpServerResponse } from "effect/unstable/http"
import { openInspectorDb } from "./db"
import { sessionsHttpResponse } from "./routes"
import { sessionFeedRows, sessionFeedRowsMerged, parseSessionsFeedQuery, SESSIONS_LIMIT_DEFAULT, SESSIONS_LIMIT_MAX } from "./session-feed"
import type { ScanIO } from "./session-scan"
import { insertSession, makeFixtureSessionDb, nodeScanIO, readBytes, tempDirs, writeSessionFolder } from "./session-inspector.test-utils"

// Task 3 AC1/AC4 — sessions feed over the REAL engine schema (fixture built by
// replaying the repo's own migration journal), read-only through Task 2's
// openInspectorDb seam (same function the core uses — identity by import).

function fixtureDb() {
  const dirs = tempDirs()
  const dbPath = path.join(dirs.configDir, "engine.db")
  makeFixtureSessionDb(dbPath)
  return { dirs, dbPath }
}

describe("sessions feed — mapped fields, ordering, limits (AC1)", () => {
  test("returns exactly the mapped fields for fixture rows, sorted time_updated desc with documented id-desc tiebreak", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      insertSession(dbPath, { id: "ses_old", title: "Older Alpha", timeCreated: 1000, timeUpdated: 1000, agent: "worker", cost: 0.25 })
      insertSession(dbPath, { id: "ses_new", title: "Newer Beta", timeCreated: 1100, timeUpdated: 2000, agent: "developer", parentId: "ses_old", cost: 1.5 })
      insertSession(dbPath, { id: "ses_tie_a", title: "Tie A", timeCreated: 1200, timeUpdated: 2000 })
      insertSession(dbPath, { id: "ses_tie_b", title: "Tie B", timeCreated: 1300, timeUpdated: 1900 })

      const result = sessionFeedRows({ dbPath, q: undefined, limit: undefined })
      if (!result.ok) throw new Error(`feed failed: ${result.message}`)

      // Documented rule: time_updated DESC; ties broken by id DESC — at t=2000,
      // "ses_tie_a" sorts above "ses_new" lexicographically, and t=1900 precedes t=1000.
      expect(result.rows.map((r) => r.id)).toEqual(["ses_tie_a", "ses_new", "ses_tie_b", "ses_old"])
      for (const row of result.rows) {
        expect(Object.keys(row)).toEqual(["id", "title", "agent", "time_created", "time_updated", "parent_id", "cost"])
      }
      expect(result.rows[1]).toEqual({
        id: "ses_new",
        title: "Newer Beta",
        agent: "developer",
        time_created: 1100,
        time_updated: 2000,
        parent_id: "ses_old",
        cost: 1.5,
      })
    } finally {
      dirs.cleanup()
    }
  })

  test("LIKE filter narrows by title and, separately, by id", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      insertSession(dbPath, { id: "ses_alpha_001", title: "Alpha rollout", timeCreated: 1, timeUpdated: 3 })
      insertSession(dbPath, { id: "ses_beta_002", title: "Beta investigation", timeCreated: 2, timeUpdated: 2 })
      insertSession(dbPath, { id: "ses_gamma_003", title: "Other", timeCreated: 3, timeUpdated: 1 })

      const byTitle = sessionFeedRows({ dbPath, q: "rollout", limit: undefined })
      if (!byTitle.ok) throw new Error("feed failed")
      expect(byTitle.rows.map((r) => r.id)).toEqual(["ses_alpha_001"])

      const byId = sessionFeedRows({ dbPath, q: "beta_00", limit: undefined })
      if (!byId.ok) throw new Error("feed failed")
      expect(byId.rows.map((r) => r.id)).toEqual(["ses_beta_002"])
    } finally {
      dirs.cleanup()
    }
  })

  test("LIKE wildcards in q are literal, not patterns", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      insertSession(dbPath, { id: "ses_lit", title: "Match A%B literal", timeCreated: 1, timeUpdated: 2 })
      insertSession(dbPath, { id: "ses_axb", title: "Not AXB", timeCreated: 2, timeUpdated: 1 })

      const result = sessionFeedRows({ dbPath, q: "A%B", limit: undefined })
      if (!result.ok) throw new Error("feed failed")
      expect(result.rows.map((r) => r.id)).toEqual(["ses_lit"])
    } finally {
      dirs.cleanup()
    }
  })

  test("limit is enforced; query parsing clamps to the documented bound and bounds", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      for (let i = 0; i < 5; i++) {
        insertSession(dbPath, { id: `ses_${i}`, title: `S${i}`, timeCreated: i, timeUpdated: i })
      }
      const limited = sessionFeedRows({ dbPath, q: undefined, limit: 3 })
      if (!limited.ok) throw new Error("feed failed")
      expect(limited.rows.map((r) => r.id)).toEqual(["ses_4", "ses_3", "ses_2"])

      expect(SESSIONS_LIMIT_DEFAULT).toBe(100)
      expect(SESSIONS_LIMIT_MAX).toBe(500)

      const parsedBig = parseSessionsFeedQuery(new URLSearchParams("limit=99999"))
      expect(parsedBig.ok && parsedBig.value.limit).toBe(SESSIONS_LIMIT_MAX)
      const parsedDefault = parseSessionsFeedQuery(new URLSearchParams(""))
      expect(parsedDefault.ok && parsedDefault.value).toEqual({ q: undefined, limit: SESSIONS_LIMIT_DEFAULT })
      const parsedBad = parseSessionsFeedQuery(new URLSearchParams("limit=abc"))
      expect(parsedBad.ok).toBe(false)
    } finally {
      dirs.cleanup()
    }
  })
})

describe("sessions feed — read-only, never migrates, never mutates (AC4)", () => {
  test("feed reads through the read-only seam: writes throw on that connection, file bytes unchanged, no WAL/sidecar files", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      insertSession(dbPath, { id: "ses_a", title: "A", timeCreated: 1, timeUpdated: 1 })
      const before = readBytes(dbPath)

      // the seam the core uses (import-identical) is write-incapable:
      const probe = openInspectorDb(dbPath)
      try {
        expect(() => probe.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('nope','p','s','d','t','v',1,1)")).toThrow()
      } finally {
        probe.close()
      }

      const result = sessionFeedRows({ dbPath, q: undefined, limit: undefined })
      if (!result.ok) throw new Error(`feed failed: ${result.message}`)
      expect(result.rows.map((r) => r.id)).toEqual(["ses_a"])

      const after = readBytes(dbPath)
      expect(after.equals(before)).toBe(true)
      const sidecars = readdirSync(dirs.configDir).filter((name) => name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal"))
      expect(sidecars).toEqual([])
      // migration bookkeeping not written by the read path:
      const check = new Database(dbPath, { readonly: true })
      try {
        const tables = check.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
        expect(tables.map((t) => t.name)).not.toContain("_drizzle_migrations")
      } finally {
        check.close()
      }
      expect(existsSync(dbPath)).toBe(true)
    } finally {
      dirs.cleanup()
    }
  })

  test("missing DB file → typed failure result, no throw", () => {
    const result = sessionFeedRows({ dbPath: "/tmp/definitely-not-here-si/none.db", q: undefined, limit: undefined })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("definitely-not-here-si")
  })
})

describe("sessions feed — input validation is Zod-typed (Result-style)", () => {
  test("parse results are ok/invalid, never thrown", () => {
    expect(parseSessionsFeedQuery(new URLSearchParams("q=hello&limit=10")).ok).toBe(true)
    expect(parseSessionsFeedQuery(new URLSearchParams("limit=0")).ok).toBe(false)
    expect(parseSessionsFeedQuery(new URLSearchParams("limit=-5")).ok).toBe(false)
    expect(parseSessionsFeedQuery(new URLSearchParams("limit=1.5")).ok).toBe(false)
  })

  test("route media type is application/json; invalid params give the observed BadRequest shape", async () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      insertSession(dbPath, { id: "ses_json", title: "J", timeCreated: 1, timeUpdated: 1 })
      const deps = {
        configPath: path.join(dirs.configDir, "session-inspector.json"),
        io: { read: () => ({ kind: "missing" as const }) },
        baseDirs: { configDir: dirs.configDir, agentsDir: "", logsDir: "" },
        engine: { envOpenCodeDb: dbPath, channel: "latest", disableChannelDb: false, dataDir: dirs.configDir },
      }
      const web = HttpServerResponse.toWeb(sessionsHttpResponse(new URLSearchParams(""), deps))
      expect(web.status).toBe(200)
      expect(web.headers.get("content-type")).toStartWith("application/json")
      const parsed = (await web.json()) as Array<{ id: string }>
      expect(parsed.map((r) => r.id)).toEqual(["ses_json"])
      expect(Array.isArray(parsed)).toBe(true)

      const badWeb = HttpServerResponse.toWeb(sessionsHttpResponse(new URLSearchParams("limit=abc"), deps))
      expect(badWeb.status).toBe(400)
      const badBody = (await badWeb.json()) as { name: string; data: { message: string } }
      expect(badBody.name).toBe("BadRequest")
      expect(badBody.data.message).toContain("limit")
    } finally {
      dirs.cleanup()
    }
  })
})


// AD42 — folder-name search merged into the feed (card: "Find sessions by folder name
// when the session id is unknown"). Law: when q is present, agentsRoot folder NAMES are
// matched first (same user-literal-escaping semantics as the SQL LIKE path); content
// (session.md) is read for name-matched candidate dirs ONLY; the match resolves via that
// folder's session.md frontmatter sessionId; the merged response carries the FULL DB row
// when the session is in the engine DB (joins the unchanged comparator) and the exact
// scan-route record shape otherwise (no invented fields); id-based dedup, DB form wins;
// q absent → byte-identical existing behavior with ZERO filesystem touching.

type MergedRow = Record<string, unknown>

function fsReadCounter() {
  const base = nodeScanIO()
  const dirListings: string[] = []
  const fileReads: string[] = []
  const io: ScanIO = {
    readDir: (dir) => {
      dirListings.push(dir)
      return base.readDir(dir)
    },
    read: (file) => {
      fileReads.push(file)
      return base.read(file)
    },
  }
  return { io, dirListings, fileReads }
}

function mergedRows(input: { dbPath: string; q: string | undefined; agentsRoot: string; io: ScanIO }): MergedRow[] {
  const result = sessionFeedRowsMerged(input)
  if (!result.ok) throw new Error(`merged feed failed: ${result.message}`)
  return result.rows as unknown as MergedRow[]
}

function plainFeed(dbPath: string, q: string | undefined): MergedRow[] {
  const result = sessionFeedRows({ dbPath, q, limit: undefined })
  if (!result.ok) throw new Error(`feed failed: ${result.message}`)
  return result.rows as unknown as MergedRow[]
}

describe("sessions feed — folder-name search merge (AD42)", () => {
  test("folder-name substring resolves via session.md frontmatter; the session appears in DB form", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      // the owner's verbatim example folder name as the fixture
      insertSession(dbPath, { id: "ses_byfolder", title: "Unrelated title", timeCreated: 100, timeUpdated: 900 })
      insertSession(dbPath, { id: "ses_other", title: "Also unrelated", timeCreated: 1, timeUpdated: 1 })
      writeSessionFolder(path.join(dirs.agentsDir, "00906918289366585344"), { sessionId: "ses_byfolder" })

      const rows = mergedRows({ dbPath, q: "00906918", agentsRoot: dirs.agentsDir, io: nodeScanIO() })
      expect(rows.map((r) => r.id)).toEqual(["ses_byfolder"])
      expect(Object.keys(rows[0])).toEqual(["id", "title", "agent", "time_created", "time_updated", "parent_id", "cost"])
    } finally {
      dirs.cleanup()
    }
  })

  test("folder-resolved DB rows join the unchanged ordering (time_updated DESC, id DESC)", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      insertSession(dbPath, { id: "ses_title", title: "shared9 report", timeCreated: 1, timeUpdated: 3000 })
      insertSession(dbPath, { id: "ses_folder2", title: "Unrelated fl2", timeCreated: 2, timeUpdated: 3000 })
      insertSession(dbPath, { id: "ses_folder1", title: "Unrelated fl1", timeCreated: 3, timeUpdated: 2000 })
      writeSessionFolder(path.join(dirs.agentsDir, "shared9dir"), { sessionId: "ses_folder1" })
      writeSessionFolder(path.join(dirs.agentsDir, "shared9dir_two"), { sessionId: "ses_folder2" })

      // q matches ONLY ses_title by title/id; the two folder-named sessions join via folder names.
      const rows = mergedRows({ dbPath, q: "shared9", agentsRoot: dirs.agentsDir, io: nodeScanIO() })
      // t=3000 tie broken by id DESC ("ses_title" > "ses_folder2"), then t=2000.
      expect(rows.map((r) => r.id)).toEqual(["ses_title", "ses_folder2", "ses_folder1"])
    } finally {
      dirs.cleanup()
    }
  })

  test("dedup law: a session matched by id AND folder name appears ONCE, DB form wins", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      insertSession(dbPath, { id: "dup9ses", title: "no folder words here", timeCreated: 1, timeUpdated: 10 })
      writeSessionFolder(path.join(dirs.agentsDir, "dup9_mirror"), { sessionId: "dup9ses" })

      const counters = fsReadCounter()
      const rows = mergedRows({ dbPath, q: "dup9", agentsRoot: dirs.agentsDir, io: counters.io })
      // the folder lane must REALLY run (name matches — a stub that ignores folders would
      // pass a bare "appears once" vacuously); with BOTH paths hitting, dedup keeps it single.
      expect(counters.dirListings.length).toBeGreaterThan(0)
      expect(rows.length).toBe(1)
      expect(rows[0].id).toBe("dup9ses")
      expect(Object.keys(rows[0])).toEqual(["id", "title", "agent", "time_created", "time_updated", "parent_id", "cost"])
    } finally {
      dirs.cleanup()
    }
  })

  test("folder matcher obeys the SAME literal law as the SQL path: title-path and folder-path hits are identical (backslash forms included)", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      // Names appear BOTH as DB titles (exercised by the shipped FEED_SQL LIKE path)
      // and as folder names (the folder matcher). PARITY of the two id-sets per query
      // IS the law — no invented escaping semantics.
      const pairs: Array<[string, string]> = [
        ["pct%9x", "ses_pct"],
        ["pctX9x", "ses_decoy"],
        ["u_9x", "ses_us"],
        ["u\\Z9", "ses_bs"],
      ]
      for (const [name, id] of pairs) {
        insertSession(dbPath, { id, title: name, timeCreated: 1, timeUpdated: 1 })
        writeSessionFolder(path.join(dirs.agentsDir, name), { sessionId: id })
      }

      for (const q of ["pct%9", "u_9", "u\\_9", "u.9"]) {
        // non-vacuity: the folder lane must really run (a folder-ignoring merge would
        // pass a pure set-parity trivially).
        const counters = fsReadCounter()
        // same-ordered id sets from the title path vs the merged (title+folder) path:
        // dedup (DB form wins) makes the merged set exactly the union — parity means
        // the folder matcher never admits a name the LIKE path would reject, nor misses one it admits.
        const titleOnly = plainFeed(dbPath, q).map((r) => r.id)
        const merged = mergedRows({ dbPath, q, agentsRoot: dirs.agentsDir, io: counters.io }).map((r) => r.id)
        expect(counters.dirListings.length).toBeGreaterThan(0)
        expect(merged).toEqual(titleOnly)
      }
      // sanity that the fixture world is non-vacuous: the literal "." is not a wildcard,
      // and "%" is not one either — the plain feed finds exactly the literal-in-title rows.
      expect(plainFeed(dbPath, "pct%9").map((r) => r.id)).toEqual(["ses_pct"])
      expect(plainFeed(dbPath, "u_9").map((r) => r.id)).toEqual(["ses_us"])
    } finally {
      dirs.cleanup()
    }
  })

  test("no DB row → the exact scan-route record shape (no invented fields); empty history marks scaffoldIncomplete", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      writeSessionFolder(path.join(dirs.agentsDir, "only9fld"), { sessionId: "ses_fsonly" })
      writeSessionFolder(path.join(dirs.agentsDir, "part9fld"), { sessionId: "ses_fspart", history: "" })

      const rows = mergedRows({ dbPath, q: "9fld", agentsRoot: dirs.agentsDir, io: nodeScanIO() })
      expect(rows.length).toBe(2)
      expect(Object.keys(rows[0])).toEqual(["sessionId", "folderPath", "folderOnly"])
      expect(rows[0]).toEqual({
        sessionId: "ses_fsonly",
        folderPath: path.join(dirs.agentsDir, "only9fld"),
        folderOnly: true,
      })
      expect(rows[1].sessionId).toBe("ses_fspart")
      expect(rows[1].scaffoldIncomplete).toBe(true)
    } finally {
      dirs.cleanup()
    }
  })

  test("NO q: byte-identical to the plain feed and the filesystem is never touched", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      insertSession(dbPath, { id: "ses_a", title: "A", timeCreated: 1, timeUpdated: 2 })
      writeSessionFolder(path.join(dirs.agentsDir, "00906918289366585344"), { sessionId: "ses_a" })

      const counters = fsReadCounter()
      const result = sessionFeedRowsMerged({ dbPath, q: undefined, limit: undefined, agentsRoot: dirs.agentsDir, io: counters.io })
      if (!result.ok) throw new Error(`merged feed failed: ${result.message}`)
      expect(result.rows as unknown as MergedRow[]).toEqual(plainFeed(dbPath, undefined))
      expect(counters.dirListings.length).toBe(0)
      expect(counters.fileReads.length).toBe(0)
    } finally {
      dirs.cleanup()
    }
  })

  test("q present but NO folder-name match: body equals the plain feed, no folder content is ever read", () => {
    const { dirs, dbPath } = fixtureDb()
    try {
      insertSession(dbPath, { id: "ses_keep", title: "keepme9 report", timeCreated: 1, timeUpdated: 9 })
      writeSessionFolder(path.join(dirs.agentsDir, "zz_nofit_a"), { sessionId: "ses_nofit_a" })
      writeSessionFolder(path.join(dirs.agentsDir, "zz_nofit_b"), { sessionId: "ses_nofit_b" })

      const counters = fsReadCounter()
      const rows = mergedRows({ dbPath, q: "keepme9", agentsRoot: dirs.agentsDir, io: counters.io })
      expect(rows).toEqual(plainFeed(dbPath, "keepme9"))
      expect(rows.map((r) => r.id)).toEqual(["ses_keep"])
      expect(counters.fileReads.filter((f) => f.endsWith("session.md")).length).toBe(0)
    } finally {
      dirs.cleanup()
    }
  })
})

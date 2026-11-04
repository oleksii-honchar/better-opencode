import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import path from "path"
import { HttpServerResponse } from "effect/unstable/http"
import { openInspectorDb } from "./db"
import { sessionsHttpResponse } from "./routes"
import { sessionFeedRows, parseSessionsFeedQuery, SESSIONS_LIMIT_DEFAULT, SESSIONS_LIMIT_MAX } from "./session-feed"
import { insertSession, makeFixtureSessionDb, readBytes, tempDirs } from "./session-inspector.test-utils"

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

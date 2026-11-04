import { describe, expect, test } from "bun:test"
import path from "path"
import { HttpServerResponse } from "effect/unstable/http"
import {
  computeConfigResponseBody,
  payloadHttpResponse,
  registerInspectorRoutes,
  SESSION_INSPECTOR_CONFIG_PATH,
  SESSION_INSPECTOR_LIVE_PATH,
  SESSION_INSPECTOR_UI_PATH,
  SESSION_PAYLOAD_PATH,
  SESSION_TIMELINE_PATH,
  SESSIONS_PATH,
  SESSIONS_SCAN_PATH,
  timelineHttpResponse,
} from "./routes"
import type { SessionViewEndpointDeps } from "./routes"
import { liveSseHttpResponse } from "./routes"
import type { ResolveOutcome } from "./session-path"
import {
  insertMessage,
  insertPart,
  insertSession,
  makeFixtureSessionDb,
  memoryIO,
  GOLDEN_CATEGORY_IDS,
  historyLine,
  nodeScanIO,
  tempDirs,
  writeSessionFolder,
} from "./session-inspector.test-utils"
import { defaultInspectorConfig } from "./config.schema"
import type { SessionInspectorConfig } from "./config.schema"

// Route behavior for GET /session-inspector/config — tested at the pure core behind the
// HTTP wrapper (no live server in unit tests, per plan). The wrapper adds only
// HttpServerResponse.jsonUnsafe(body, { status }) around this core, and registerInspectorRoutes
// declares the ONLY path this module mounts (AC: registers its routes without touching others).
// Error body grammar is the repo-observed one: { name, data: { ... } } (NamedError.toObject()).

const baseDirs = { configDir: "/t/config", agentsDir: "/t/agents", logsDir: "/t/logs" }
const configPath = "/t/config/session-inspector.json"

describe("GET /session-inspector/config — merged effective config (success path)", () => {
  test("no user file → 200 with built-in defaults AND explicit configWarning marker", () => {
    const result = computeConfigResponseBody({ configPath, io: memoryIO({}), baseDirs })
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error("expected 200")
    expect(result.body.categories.map((c) => c.id)).toEqual([...GOLDEN_CATEGORY_IDS])
    expect(result.body.version).toBe(1)
    expect(result.body.configWarning?.code).toBe("CONFIG_FILE_MISSING")
    expect(result.body.configWarning?.message).toContain(configPath)
  })

  test("valid override file → 200 with merged config, warning marker absent", () => {
    const result = computeConfigResponseBody({
      configPath,
      io: memoryIO({ [configPath]: JSON.stringify({ cell: { width: 321, height: 77 } }) }),
      baseDirs,
    })
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error("expected 200")
    expect(result.body.cell).toEqual({ width: 321, height: 77 })
    expect(result.body.configWarning).toBeUndefined()
    expect(result.body.categories.map((c) => c.id)).toEqual([...GOLDEN_CATEGORY_IDS])
  })
})

describe("GET /session-inspector/config — hard fail on invalid config", () => {
  test("present-but-invalid JSON → 500 with observed name/data error shape, actionable message", () => {
    const result = computeConfigResponseBody({
      configPath,
      io: memoryIO({ [configPath]: "{ not valid json" }),
      baseDirs,
    })
    expect(result.status).toBe(500)
    if (result.status !== 500) throw new Error("expected 500")
    expect(Object.keys(result.body)).toEqual(["name", "data"])
    expect(result.body.name).toBe("SessionInspectorConfigError")
    expect(result.body.data.code).toBe("CONFIG_INVALID_JSON")
    expect(result.body.data.message).toContain(configPath)
    expect(result.body.data.path).toBe(configPath)
    // hard fail, never partial: no config sections in the body at all
    expect(JSON.stringify(result.body)).not.toContain("categories")
  })

  test("unreadable config file → 500 CONFIG_UNREADABLE, nothing thrown", () => {
    const result = computeConfigResponseBody({ configPath, io: memoryIO({}, new Set([configPath])), baseDirs })
    expect(result.status).toBe(500)
    if (result.status !== 500) throw new Error("expected 500")
    expect(result.body.name).toBe("SessionInspectorConfigError")
    expect(result.body.data.code).toBe("CONFIG_UNREADABLE")
  })

  test("schema-invalid config → 500 naming the offending field", () => {
    const result = computeConfigResponseBody({
      configPath,
      io: memoryIO({ [configPath]: JSON.stringify({ version: 99 }) }),
      baseDirs,
    })
    expect(result.status).toBe(500)
    if (result.status !== 500) throw new Error("expected 500")
    expect(result.body.data.code).toBe("CONFIG_INVALID_SCHEMA")
    expect(result.body.data.message).toContain("version")
  })
})

describe("route registration surface", () => {
  test("module declares exactly its seven routes, no others", () => {
    const added: { method: string; path: string }[] = []
    registerInspectorRoutes((method, p) => added.push({ method, path: p }))
    expect(added).toEqual([
      { method: "GET", path: SESSION_INSPECTOR_UI_PATH },
      { method: "GET", path: SESSION_INSPECTOR_CONFIG_PATH },
      { method: "GET", path: SESSIONS_PATH },
      { method: "GET", path: SESSIONS_SCAN_PATH },
      { method: "GET", path: SESSION_TIMELINE_PATH },
      { method: "GET", path: SESSION_PAYLOAD_PATH },
      { method: "GET", path: SESSION_INSPECTOR_LIVE_PATH },
    ])
    // UI mount ORDER: the UI path is registered BEFORE the API paths so the static
    // exact-match pattern wins over the API's :sessionID parameter segments.
    expect(added.findIndex((r) => r.path === SESSION_INSPECTOR_UI_PATH)).toBeLessThan(
      added.findIndex((r) => r.path === SESSION_TIMELINE_PATH),
    )
    // LIVE-BOOT REGRESSION (dev instance, 2026-11-04): the raw route trie (find-my-way-ts)
    // treats "/x" and "/x/" as the SAME node and THROWS on duplicate declaration. No two
    // declared paths may collide once normalized — this is why there is no
    // "/session-inspector" alias beside "/session-inspector/".
    const normalized = added.map((r) => r.path.replace(/\/$/, ""))
    expect(new Set(normalized).size).toBe(added.length)
    expect(SESSION_INSPECTOR_CONFIG_PATH).toBe("/session-inspector/config")
    expect(SESSIONS_PATH).toBe("/session-inspector/sessions")
    expect(SESSIONS_SCAN_PATH).toBe("/session-inspector/sessions/scan")
    expect(SESSION_TIMELINE_PATH).toBe("/session-inspector/session/:sessionID/timeline")
    expect(SESSION_PAYLOAD_PATH).toBe("/session-inspector/session/:sessionID/payload")
    expect(SESSION_INSPECTOR_UI_PATH).toBe("/session-inspector/")
  })
})

// -- timeline + payload endpoints (Task 4) -------------------------------------

const VIEW = "ses_t4_endpoint_view"

interface EndpointFixture {
  configPath: string
  configJson: string
  depsBase: Omit<SessionViewEndpointDeps, "resolveSessionPath">
  folder: string
  cleanup: () => void
}

function endpointFixture(): EndpointFixture {
  const dirs = tempDirs()
  const dbPath = path.join(dirs.configDir, "engine.db")
  makeFixtureSessionDb(dbPath)
  insertSession(dbPath, { id: VIEW, title: "endpoint view", timeCreated: 1000, timeUpdated: 4000 })
  insertMessage(dbPath, { id: "msg_e", sessionId: VIEW, timeCreated: 2000, role: "assistant" })
  insertPart(dbPath, { id: "prt_e", messageId: "msg_e", sessionId: VIEW, timeCreated: 2000, data: { type: "text", text: "endpoint body" } })

  const folder = path.join(dirs.agentsDir, "e1", VIEW)
  writeSessionFolder(folder, {
    sessionId: VIEW,
    history: [historyLine({ ts: "2026-11-03T09:00:00.000Z", sessionId: VIEW, agent: "worker", event: "started", nextAgent: "worker" })].join("\n") + "\n",
  })

  const config: SessionInspectorConfig = defaultInspectorConfig({ agentsRoot: dirs.agentsDir, logsDir: dirs.logsDir })
  const effective: SessionInspectorConfig = { ...config, paths: { ...config.paths, dbMode: dbPath } }
  const configPath = path.join(dirs.configDir, "session-inspector.json")
  const configJson = JSON.stringify(effective)
  const depsBase: Omit<SessionViewEndpointDeps, "resolveSessionPath"> = {
    configPath,
    io: memoryIO({ [configPath]: configJson }),
    baseDirs: { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir },
    engine: { envOpenCodeDb: undefined, channel: "test", disableChannelDb: false, dataDir: dirs.configDir },
    fsIo: nodeScanIO(),
  }
  return { configPath, configJson, depsBase, folder, cleanup: dirs.cleanup }
}

function viewDeps(fixture: EndpointFixture, resolveSessionPath: (id: string) => ResolveOutcome): SessionViewEndpointDeps {
  return { ...fixture.depsBase, resolveSessionPath }
}

async function toWebText(response: HttpServerResponse.HttpServerResponse) {
  const web = HttpServerResponse.toWeb(response)
  const headers: Record<string, string | null> = {}
  for (const key of ["content-type", "content-length"]) headers[key] = web.headers.get(key)
  // single read of the body stream (ReadableStream is single-use)
  const text = await web.text()
  return { status: web.status, headers, text }
}

describe("GET /session-inspector/session/:sessionID/timeline (Task 4)", () => {
  test("streams NDJSON envelopes: exact media type, no content-length, five-key rows, history joined", async () => {
    const fixture = endpointFixture()
    try {
      const response = timelineHttpResponse(VIEW, new URLSearchParams(), viewDeps(fixture, () => ({ ok: true, path: fixture.folder })))
      const result = await toWebText(response)
      expect(result.status).toBe(200)
      expect(result.headers["content-type"]).toBe("application/x-ndjson")
      expect(result.headers["content-length"]).toBeNull()
      const lines = result.text.split("\n").filter((l) => l.length > 0)
      expect(lines.length).toBeGreaterThanOrEqual(2) // db part + history line
      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>
        expect(Object.keys(parsed)).toEqual(["category", "ts", "sourceRef", "summary", "payloadRef"])
      }
      expect(lines.some((l) => (JSON.parse(l) as { category: string }).category === "assistant-text")).toBe(true)
      expect(lines.some((l) => (JSON.parse(l) as { category: string }).category === "pipeline")).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test("exactly ONE resolver spawn per session view (process-spawn counter) and its path is used", async () => {
    const fixture = endpointFixture()
    try {
      let spawnCount = 0
      const counted = (id: string): ResolveOutcome => {
        spawnCount += 1
        return { ok: true, path: fixture.folder }
      }
      const response = timelineHttpResponse(VIEW, new URLSearchParams(), viewDeps(fixture, counted))
      const result = await toWebText(response)
      expect(spawnCount).toBe(1)
      expect(result.text).toContain("pipeline") // resolved folder was actually read
    } finally {
      fixture.cleanup()
    }
  })

  test("resolver non-zero exit → fallback walk of the configured roots still finds the folder", async () => {
    const fixture = endpointFixture()
    try {
      let attempted = 0
      const failing = (): ResolveOutcome => {
        attempted += 1
        return { ok: false, reason: "NOT_FOUND (exit 1)" }
      }
      const response = timelineHttpResponse(VIEW, new URLSearchParams(), viewDeps(fixture, failing))
      const result = await toWebText(response)
      expect(attempted).toBe(1)
      // fallback walk discovered the folder under agentsRoot: history line included
      expect(result.text).toContain("pipeline")
    } finally {
      fixture.cleanup()
    }
  })

  test("invalid categories / from values → observed BadRequest grammar, no throw", async () => {
    const fixture = endpointFixture()
    try {
      const response = timelineHttpResponse(VIEW, new URLSearchParams({ categories: "not-a-column" }), viewDeps(fixture, () => ({ ok: true, path: fixture.folder })))
      const result = await toWebText(response)
      expect(result.status).toBe(400)
      const body = JSON.parse(result.text) as { name: string; data: { message: string } }
      expect(body.name).toBe("BadRequest")
      expect(body.data.message).toContain("categories")
    } finally {
      fixture.cleanup()
    }
  })
})

describe("GET /session-inspector/session/:sessionID/live (Task 6 SSE, OD-1)", () => {
  const idleEvent = { id: "evt_i", type: "session.idle", properties: { sessionID: VIEW } }
  const foreignIdle = { id: "evt_f", type: "session.idle", properties: { sessionID: "ses_not_scope" } }
  const partUpdated = {
    id: "evt_p",
    type: "message.part.updated",
    properties: { sessionID: VIEW, time: 2000, part: { id: "prt_e", messageID: "msg_e", sessionID: VIEW, type: "text", text: "endpoint body" } },
  }

  test("text/event-stream, no content-length; frame body is 'data: ' + exact NDJSON line bytes (§6.6)", async () => {
    const fixture = endpointFixture()
    try {
      const deps = viewDeps(fixture, () => ({ ok: true, path: fixture.folder }))
      const timeline = await toWebText(timelineHttpResponse(VIEW, new URLSearchParams(), deps))
      const partLine = timeline.text.split("\n").find((l) => l.includes('"prt_e"'))
      expect(partLine).toBeDefined()

      const response = liveSseHttpResponse(VIEW, [partUpdated, foreignIdle, idleEvent], deps)
      const result = await toWebText(response)
      expect(result.status).toBe(200)
      expect(result.headers["content-type"]).toBe("text/event-stream")
      expect(result.headers["content-length"]).toBeNull()
      const frames = result.text.split("\n\n").filter((f) => f.length > 0)
      expect(frames.length).toBe(2) // in-scope part.updated + in-scope idle; foreign dropped
      expect(frames[0]).toBe(`data: ${partLine}`)
      const idleEnvelope = JSON.parse(frames[1].slice("data: ".length)) as Record<string, unknown>
      expect(Object.keys(idleEnvelope)).toEqual(["category", "ts", "sourceRef", "summary", "payloadRef"])
      expect(idleEnvelope.payloadRef).toBeNull()
    } finally {
      fixture.cleanup()
    }
  })

  test("config read failure on live view -> same 500 grammar as every view endpoint (Result-style, no throw)", async () => {
    const fixture = endpointFixture()
    try {
      const broken: SessionViewEndpointDeps = {
        ...fixture.depsBase,
        io: memoryIO({ [fixture.configPath]: "{ not json" }),
        resolveSessionPath: () => ({ ok: false, reason: "NOT_FOUND (exit 1)" }),
      }
      const result = await toWebText(liveSseHttpResponse(VIEW, [idleEvent], broken))
      expect(result.status).toBe(500)
      expect(JSON.parse(result.text).name).toBe("SessionInspectorConfigError")
    } finally {
      fixture.cleanup()
    }
  })
})

describe("GET /session-inspector/session/:sessionID/payload (Task 4)", () => {
  test("explicit object JSON (never NDJSON) with truncated/fullLength always present", async () => {
    const fixture = endpointFixture()
    try {
      const response = payloadHttpResponse(
        VIEW,
        new URLSearchParams({ kind: "dbId", dbId: "prt_e" }),
        viewDeps(fixture, () => ({ ok: true, path: fixture.folder })),
      )
      const result = await toWebText(response)
      expect(result.status).toBe(200)
      expect(result.headers["content-type"]).toContain("application/json")
      const body = JSON.parse(result.text) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual([
        "fullLength",
        "kind",
        "payload",
        "resolved",
        "source",
        "truncated",
      ].sort())
      expect(body.truncated).toBe(false)
      expect(typeof body.fullLength).toBe("number")
      expect((body.payload as { text: string }).text).toBe("endpoint body")
    } finally {
      fixture.cleanup()
    }
  })

  test("history payload requires a session view: resolver called at most once", async () => {
    const fixture = endpointFixture()
    try {
      let called = 0
      const counted = (): ResolveOutcome => {
        called += 1
        return { ok: true, path: fixture.folder }
      }
      const response = payloadHttpResponse(VIEW, new URLSearchParams({ kind: "historyLine", line: "1" }), viewDeps(fixture, counted))
      const result = await toWebText(response)
      expect(result.status).toBe(200)
      expect(called).toBe(1)
      const body = JSON.parse(result.text) as { payload: { event: string } }
      expect(body.payload.event).toBe("started")
    } finally {
      fixture.cleanup()
    }
  })

  test("dbId payload never spawns the resolver", async () => {
    const fixture = endpointFixture()
    try {
      let called = 0
      const counted = (): ResolveOutcome => {
        called += 1
        return { ok: true, path: fixture.folder }
      }
      const response = payloadHttpResponse(VIEW, new URLSearchParams({ kind: "dbId", dbId: "prt_e" }), viewDeps(fixture, counted))
      await toWebText(response)
      expect(called).toBe(0)
    } finally {
      fixture.cleanup()
    }
  })

  test("unparseable ref → 400 BadRequest grammar", async () => {
    const fixture = endpointFixture()
    try {
      const response = payloadHttpResponse(VIEW, new URLSearchParams({ kind: "wat" }), viewDeps(fixture, () => ({ ok: true, path: fixture.folder })))
      const result = await toWebText(response)
      expect(result.status).toBe(400)
      const body = JSON.parse(result.text) as { name: string }
      expect(body.name).toBe("BadRequest")
    } finally {
      fixture.cleanup()
    }
  })
})

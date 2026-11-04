import { existsSync, readdirSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { loadInspectorConfig } from "./config"
import type { ConfigIO, ConfigFailure, ConfigWarning, InspectorBaseDirs } from "./config"
import { buildCategoryRouter } from "./category-mapper"
import { resolveInspectorDbPath, openInspectorDb } from "./db"
import type { EngineDbInputs } from "./db"
import { SESSION_INSPECTOR_CONFIG_ERROR_NAME } from "./errors"
import { parseSessionsFeedQuery, sessionFeedRows } from "./session-feed"
import { buildTimeline } from "./timeline"
import type { TimelineFilters, TimelineEnvelope, PartRowView } from "./timeline"
import { parsePayloadRef, resolvePayload } from "./payload"
import { SESSION_INSPECTOR_UI_PATH, uiHttpResponse } from "./ui"
import { liveEnvelopeFor, liveSseFrameBody, SESSION_INSPECTOR_LIVE_PATH } from "./live"
import type { LiveEventPayload } from "./live"
import { GlobalBus } from "@/bus/global"
import { makeResolverSessionPath } from "./session-path"
import type { ResolveOutcome } from "./session-path"
import { scanSessionFolders } from "./session-scan"
import type { ScanIO } from "./session-scan"
import type { SessionInspectorConfig } from "./config.schema"

// Raw routes at the existing composition point (docRoute/ptyConnectRoute
// precedent): the module registers its routes itself; no existing route file
// is touched beyond the one composition entry in server/routes/instance/httpapi/server.ts.
//
// Every request logic is a TOTAL PURE FUNCTION of injected deps; every failure
// path returns a response value (Result-style — nothing throws, so no throw can
// escape a handler). Error bodies use the repo-observed grammar:
//   invalid input        -> { name: "BadRequest", data: { message } }                 (middleware/schema-error.ts)
//   inspector-side state -> { name: <DomainError>, data: { message, ... } } @ 500     (middleware/error.ts / NamedError.toObject)
// Media types per §6.6: object endpoints JSON, stream endpoints NDJSON.

export const SESSION_INSPECTOR_CONFIG_PATH = "/session-inspector/config"
export const SESSIONS_PATH = "/session-inspector/sessions"
export const SESSIONS_SCAN_PATH = "/session-inspector/sessions/scan"
export const SESSION_TIMELINE_PATH = "/session-inspector/session/:sessionID/timeline"
export const SESSION_PAYLOAD_PATH = "/session-inspector/session/:sessionID/payload"
// The UI page path is DEFINED in ui.ts (the page owns its URL) but re-exported here:
// the route census below registers it and the census test reads it from this module.
// No "/session-inspector" alias: the raw route trie (find-my-way-ts) folds trailing
// slashes into ONE node and throws on duplicate declaration (live-boot crash 2026-11-04).
export { SESSION_INSPECTOR_UI_PATH } from "./ui"
// The live path is DEFINED in live.ts; re-exported for the same single-surface census rule.
export { SESSION_INSPECTOR_LIVE_PATH } from "./live"

export interface ConfigResponseBodySuccess extends SessionInspectorConfig {
  configWarning?: ConfigWarning
}

export interface ErrorResponseBody {
  name: string
  data: { message: string; code?: string; path?: string }
}

export type ConfigResponse =
  | { status: 200; body: ConfigResponseBodySuccess }
  | { status: 500; body: { name: typeof SESSION_INSPECTOR_CONFIG_ERROR_NAME; data: { message: string; code: string; path: string } } }

export interface ConfigEndpointDeps {
  configPath: string
  io: ConfigIO
  baseDirs: InspectorBaseDirs
}

export function computeConfigResponseBody(deps: ConfigEndpointDeps): ConfigResponse {
  const loaded = loadInspectorConfig({ configPath: deps.configPath, io: deps.io, baseDirs: deps.baseDirs })
  if (!loaded.ok) return { status: 500, body: configErrorBody(loaded) }
  const body: ConfigResponseBodySuccess = { ...loaded.config }
  if (loaded.warning !== undefined) body.configWarning = loaded.warning
  return { status: 200, body }
}

type ConfigErrorBody = {
  name: typeof SESSION_INSPECTOR_CONFIG_ERROR_NAME
  data: { message: string; code: string; path: string }
}

function configErrorBody(failure: ConfigFailure): ConfigErrorBody {
  return {
    name: SESSION_INSPECTOR_CONFIG_ERROR_NAME,
    data: { message: failure.message, code: failure.code, path: failure.path },
  }
}

export function configHttpResponse(deps: ConfigEndpointDeps) {
  const result = computeConfigResponseBody(deps)
  return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
}

// -- sessions feed -------------------------------------------------------------

export interface SessionsEndpointDeps extends ConfigEndpointDeps {
  engine: EngineDbInputs
}

export function sessionsHttpResponse(params: URLSearchParams, deps: SessionsEndpointDeps) {
  const query = parseSessionsFeedQuery(params)
  if (!query.ok) return badRequestResponse(query.issues.join("\n"))

  const config = loadInspectorConfig(deps)
  if (!config.ok) return HttpServerResponse.jsonUnsafe(configErrorBody(config), { status: 500 })

  const dbPath = resolveInspectorDbPath({ dbMode: config.config.paths.dbMode, engine: deps.engine })
  const rows = sessionFeedRows({ dbPath, q: query.value.q, limit: query.value.limit })
  if (!rows.ok) {
    return HttpServerResponse.jsonUnsafe(
      {
        name: "SessionInspectorDbError",
        data: { message: rows.message, code: "DB_UNREADABLE", path: dbPath },
      },
      { status: 500 },
    )
  }
  return HttpServerResponse.jsonUnsafe(rows.rows)
}

function badRequestResponse(message: string) {
  // observed literal at middleware/schema-error.ts: { name: "BadRequest", data: { message, kind } }
  return HttpServerResponse.jsonUnsafe({ name: "BadRequest", data: { message } }, { status: 400 })
}

// -- sessions scan -------------------------------------------------------------

export interface ScanEndpointDeps {
  configPath: string
  configIo: ConfigIO
  baseDirs: InspectorBaseDirs
  io: ScanIO
}

const isAbsoluteRoot = (value: string): boolean => path.isAbsolute(value)

export function sessionsScanHttpResponse(params: URLSearchParams, deps: ScanEndpointDeps) {
  // roots: config paths.agentsRoot (when set) + explicit absolute ?roots= params
  const rootParams = params.getAll("roots").flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value.length > 0)
  const invalid = rootParams.find((value) => !isAbsoluteRoot(value))
  if (invalid !== undefined) {
    return badRequestResponse(`roots: each entry must be an absolute path (got "${invalid}")`)
  }

  const config = loadInspectorConfig({ configPath: deps.configPath, io: deps.configIo, baseDirs: deps.baseDirs })
  if (!config.ok) return HttpServerResponse.jsonUnsafe(configErrorBody(config), { status: 500 })

  const roots = [...(config.config.paths.agentsRoot.length > 0 ? [config.config.paths.agentsRoot] : []), ...rootParams]
  const lines = (function* (): Generator<string> {
    for (const record of scanSessionFolders({ roots, io: deps.io })) yield JSON.stringify(record) + "\n"
  })()

  return HttpServerResponse.stream(
    Stream.fromIterable(lines).pipe(Stream.encodeText),
    { contentType: "application/x-ndjson" },
  )
}

// -- session view (timeline + payload) ------------------------------------------

export interface SessionViewEndpointDeps extends ConfigEndpointDeps {
  engine: EngineDbInputs
  /** File IO for the resolved session folder and the tools.log dir. */
  fsIo: ScanIO
  /** Exactly ONE call per session view (spawn-count contract, DEC-0011 invariant). */
  resolveSessionPath: (sessionId: string, agentsRoot: string) => ResolveOutcome
}

const timelineIdPattern = /^\/session-inspector\/session\/([^/]+)\/timeline$/
const payloadIdPattern = /^\/session-inspector\/session\/([^/]+)\/payload$/

export function timelineSessionId(pathname: string): string | undefined {
  return timelineIdPattern.exec(pathname)?.[1]
}

export function payloadSessionId(pathname: string): string | undefined {
  return payloadIdPattern.exec(pathname)?.[1]
}

// One session view = at most ONE resolver spawn; on non-zero exit the SAME scan-walk
// method as the /sessions/scan endpoint discovers the folder (spec §5.1-5 fallback).
function resolveSessionViewFolder(sessionId: string, agentsRoot: string, deps: SessionViewEndpointDeps): string | undefined {
  const direct = deps.resolveSessionPath(sessionId, agentsRoot)
  if (direct.ok) return direct.path
  if (!path.isAbsolute(agentsRoot)) return undefined
  for (const record of scanSessionFolders({ roots: [agentsRoot], io: deps.fsIo })) {
    if (record.sessionId === sessionId) return record.folderPath
  }
  return undefined
}

function parseTimelineFilters(params: URLSearchParams, config: SessionInspectorConfig): { ok: true; value: TimelineFilters } | { ok: false; message: string } {
  const value: TimelineFilters = {}
  for (const name of ["from", "to"] as const) {
    const raw = params.get(name)
    if (raw !== null) {
      if (Number.isNaN(Date.parse(raw))) return { ok: false, message: `${name}: expected an ISO-8601 timestamp (got "${raw}")` }
      value[name] = raw
    }
  }
  const categoriesRaw = params.get("categories")
  if (categoriesRaw !== null) {
    const ids = categoriesRaw.split(",").map((id) => id.trim()).filter((id) => id.length > 0)
    const configured = new Set(config.categories.map((category) => category.id))
    const unknown = ids.find((id) => !configured.has(id))
    if (unknown !== undefined) return { ok: false, message: `categories: "${unknown}" is not a configured column` }
    value.categories = ids
  }
  return { ok: true, value }
}

export function timelineHttpResponse(sessionId: string, params: URLSearchParams, deps: SessionViewEndpointDeps) {
  const config = loadInspectorConfig(deps)
  if (!config.ok) return HttpServerResponse.jsonUnsafe(configErrorBody(config), { status: 500 })

  const filters = parseTimelineFilters(params, config.config)
  if (!filters.ok) return badRequestResponse(filters.message)

  const dbPath = resolveInspectorDbPath({ dbMode: config.config.paths.dbMode, engine: deps.engine })
  const agentsRoot = config.config.paths.agentsRoot
  const sessionPath = resolveSessionViewFolder(sessionId, agentsRoot, deps)

  const result = buildTimeline({ dbPath, sessionId, sessionPath, io: deps.fsIo, config: config.config, filters: filters.value })
  if (!result.ok) {
    if (result.code === "INVALID_FILTER") return badRequestResponse(result.message)
    return HttpServerResponse.jsonUnsafe(
      { name: "SessionInspectorDbError", data: { message: result.message, code: "DB_UNREADABLE", path: dbPath } },
      { status: 500 },
    )
  }

  const lines = (function* (): Generator<string> {
    for (const envelope of result.envelopes) yield JSON.stringify(envelope) + "\n"
  })()
  return HttpServerResponse.stream(
    Stream.fromIterable(lines).pipe(Stream.encodeText),
    { contentType: "application/x-ndjson" },
  )
}

export function payloadHttpResponse(sessionId: string, params: URLSearchParams, deps: SessionViewEndpointDeps) {
  const config = loadInspectorConfig(deps)
  if (!config.ok) return HttpServerResponse.jsonUnsafe(configErrorBody(config), { status: 500 })

  const ref = parsePayloadRef(params)
  if (!ref.ok) return badRequestResponse(ref.message)

  const dbPath = resolveInspectorDbPath({ dbMode: config.config.paths.dbMode, engine: deps.engine })
  // only file-backed refs need the session folder — a dbId payload never spawns a resolver
  let sessionPath: string | undefined
  if (ref.ref.kind !== "dbId") {
    sessionPath = resolveSessionViewFolder(sessionId, config.config.paths.agentsRoot, deps)
  }

  const result = resolvePayload({ dbPath, sessionId, sessionPath, io: deps.fsIo, config: config.config, ref: ref.ref })
  const body: Record<string, unknown> = {
    resolved: result.resolved,
    kind: result.kind,
    source: result.source,
    payload: result.payload,
    truncated: result.truncated,
    fullLength: result.fullLength,
  }
  if (result.sourceAbsent !== undefined) body.sourceAbsent = result.sourceAbsent
  return HttpServerResponse.jsonUnsafe(body)
}

// -- live tail (Task 6) — OD-1: SSE over this module's raw router; the frame body is
// the EXACT NDJSON timeline-line bytes with the SSE "data: " prefix (§6.6). Reason the
// existing /global/event websocket is NOT reused: measured in the fork it is typed-HttpApi
// plumbing streaming RAW engine payloads for ALL directories — reusing it would duplicate
// the ratified server-side category/summary mapping in the client (breaking SC-2 and the
// one-parser rule). See live.ts header + materials/task6-live-tail-evidence.md.

const liveIdPattern = /^\/session-inspector\/session\/([^/]+)\/live$/

interface LiveSessionScope {
  childIds: string[]
  rowLookup: (partId: string) => PartRowView | undefined
  close: () => void
}

// mirrors buildTimeline's scope join; read-only connection, re-reads fresh rows per event.
function prepareLiveScope(dbPath: string, sessionId: string): LiveSessionScope {
  const db = openInspectorDb(dbPath)
  const childIds = db
    .query<{ id: string }, [string]>("SELECT id FROM session WHERE parent_id = ?")
    .all(sessionId)
    .map((row) => row.id)
  const byId = db.query<PartRowView, [string]>(
    `SELECT p.id, p.session_id, p.time_created, p.data, p.rowid, m.data AS msg_data
     FROM part p LEFT JOIN message m ON m.id = p.message_id WHERE p.id = ?`,
  )
  return {
    childIds,
    rowLookup: (partId) => byId.get(partId) ?? undefined,
    close: () => db.close(),
  }
}

// unit/testable core: a sync iterable of bus payloads -> SSE frames of envelopes
// (the production route below streams the SAME envelope+framing functions off the bus).
export function liveSseHttpResponse(sessionId: string, events: Iterable<LiveEventPayload>, deps: SessionViewEndpointDeps) {
  const config = loadInspectorConfig(deps)
  if (!config.ok) return HttpServerResponse.jsonUnsafe(configErrorBody(config), { status: 500 })
  const dbPath = resolveInspectorDbPath({ dbMode: config.config.paths.dbMode, engine: deps.engine })
  const scope = prepareLiveScope(dbPath, sessionId)
  try {
    const ctx = {
      sessionId,
      router: buildCategoryRouter(config.config),
      capBytes: config.config.limits.payloadCapBytes,
      rowLookup: scope.rowLookup,
      childIds: scope.childIds,
    }
    const frames: string[] = []
    for (const event of events) {
      const envelope = liveEnvelopeFor(event, ctx)
      if (envelope !== null) frames.push(liveSseFrameBody(envelope))
    }
    return HttpServerResponse.stream(Stream.fromIterable(frames).pipe(Stream.encodeText), { contentType: "text/event-stream" })
  } finally {
    scope.close()
  }
}

// -- route census ---------------------------------------------------------------

// Route census for this module (test-asserted; the layer below registers from
// the same list): exactly seven GETs, nothing else. The UI page entry is
// registered FIRST so the static exact path wins over API :param segments (the
// router matches by insertion order — repo precedent httpapi-ui.test.ts).
export function registerInspectorRoutes(add: (method: string, routePath: string) => void): void {
  add("GET", SESSION_INSPECTOR_UI_PATH)
  add("GET", SESSION_INSPECTOR_CONFIG_PATH)
  add("GET", SESSIONS_PATH)
  add("GET", SESSIONS_SCAN_PATH)
  add("GET", SESSION_TIMELINE_PATH)
  add("GET", SESSION_PAYLOAD_PATH)
  add("GET", SESSION_INSPECTOR_LIVE_PATH)
}

const nodeConfigIO: ConfigIO = {
  read: (target) => {
    try {
      if (!existsSync(target)) return { kind: "missing" }
      return { kind: "ok", text: readFileSync(target, "utf8") }
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) }
    }
  },
}

const nodeScanIO: ScanIO = {
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

// Composition seam (the only ambient reads in this module, done ONCE at layer
// build): config path override via SESSION_INSPECTOR_CONFIG; agents default per
// the measured AGENT_SESSIONS_DIR convention (§3); engine DB inputs mirror
// storage/db.ts's own sources (Flag/env/channel/RuntimeFlags/Global).
export function productionConfigDeps(env: Record<string, string | undefined> = process.env): ConfigEndpointDeps {
  return {
    configPath: env["SESSION_INSPECTOR_CONFIG"] ?? path.join(Global.Path.config, "session-inspector.json"),
    io: nodeConfigIO,
    baseDirs: {
      configDir: Global.Path.config,
      agentsDir: env["AGENT_SESSIONS_DIR"] ?? path.join(os.homedir(), ".agent-sessions"),
      logsDir: Global.Path.log,
    },
  }
}

export function productionEngineDbInputs(): EngineDbInputs {
  const flags = Effect.runSync(RuntimeFlags.Service.useSync((f) => f).pipe(Effect.provide(RuntimeFlags.defaultLayer)))
  return {
    envOpenCodeDb: Flag.OPENCODE_DB,
    channel: InstallationChannel,
    disableChannelDb: flags.disableChannelDb,
    dataDir: Global.Path.data,
  }
}

const RESOLVER_SCRIPT = path.join(os.homedir(), ".config", "opencode", "agents", "scripts", "resolve-session-path.mjs")

const nodeSpawnResolver: import("./session-path").SpawnResolver = (argv, env) => {
  try {
    const stdout = execFileSync(process.execPath, [...argv], { encoding: "utf8", env: { ...process.env, ...env } })
    return { exitCode: 0, stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    return { exitCode: typeof failure.status === "number" ? failure.status : 1, stdout: typeof failure.stdout === "string" ? failure.stdout : "" }
  }
}

export const productionResolveSessionPath = makeResolverSessionPath(nodeSpawnResolver, RESOLVER_SCRIPT)

export const sessionInspectorRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const configDeps = productionConfigDeps()
    const sessionsDeps: SessionsEndpointDeps = { ...configDeps, engine: productionEngineDbInputs() }
    const scanDeps: ScanEndpointDeps = { configPath: configDeps.configPath, configIo: configDeps.io, baseDirs: configDeps.baseDirs, io: nodeScanIO }
    const viewDeps: SessionViewEndpointDeps = {
      ...configDeps,
      engine: sessionsDeps.engine,
      fsIo: nodeScanIO,
      resolveSessionPath: productionResolveSessionPath,
    }
    yield* router.add("GET", SESSION_INSPECTOR_UI_PATH, () => Effect.succeed(uiHttpResponse()))
    yield* router.add("GET", SESSION_INSPECTOR_CONFIG_PATH, () => Effect.succeed(configHttpResponse(configDeps)))
    yield* router.add("GET", SESSIONS_PATH, (request) =>
      Effect.succeed(sessionsHttpResponse(new URL(request.url, "http://localhost").searchParams, sessionsDeps)),
    )
    yield* router.add("GET", SESSIONS_SCAN_PATH, (request) =>
      Effect.succeed(sessionsScanHttpResponse(new URL(request.url, "http://localhost").searchParams, scanDeps)),
    )
    yield* router.add("GET", SESSION_TIMELINE_PATH, (request) => {
      const url = new URL(request.url, "http://localhost")
      const sessionId = timelineSessionId(url.pathname) ?? ""
      return Effect.succeed(timelineHttpResponse(sessionId, url.searchParams, viewDeps))
    })
    yield* router.add("GET", SESSION_PAYLOAD_PATH, (request) => {
      const url = new URL(request.url, "http://localhost")
      const sessionId = payloadSessionId(url.pathname) ?? ""
      return Effect.succeed(payloadHttpResponse(sessionId, url.searchParams, viewDeps))
    })
    // live tail (bus -> SSE). GlobalBus is the process-level mirror of every instance
    // Bus.publish (bus/index.ts publish path measured 2026-11-04); acquire/release per
    // connection exactly like the engine's own SSE consumers (bus/global.ts comment).
    yield* router.add("GET", SESSION_INSPECTOR_LIVE_PATH, (request) =>
      Effect.gen(function* () {
        const config = loadInspectorConfig(configDeps)
        if (!config.ok) return HttpServerResponse.jsonUnsafe(configErrorBody(config), { status: 500 })
        const url = new URL(request.url, "http://localhost")
        const sessionId = liveIdPattern.exec(url.pathname)?.[1] ?? ""
        const dbPath = resolveInspectorDbPath({ dbMode: config.config.paths.dbMode, engine: sessionsDeps.engine })
        const ctxBase = {
          sessionId,
          router: buildCategoryRouter(config.config),
          capBytes: config.config.limits.payloadCapBytes,
        }
        const queue = yield* Queue.unbounded<LiveEventPayload>()
        const acquired = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const scope = prepareLiveScope(dbPath, sessionId)
            // synchronous offer from the bus callback — the same shape the engine's
            // own /global/event SSE handler uses (handlers/global.ts).
            const listener = (evt: { payload: unknown }) => {
              const payload = evt.payload as LiveEventPayload
              if (payload && typeof payload.type === "string" && typeof payload.id === "string") Queue.offerUnsafe(queue, payload)
            }
            GlobalBus.on("event", listener)
            return { scope, listener }
          }),
          ({ scope, listener }) =>
            Effect.sync(() => {
              GlobalBus.off("event", listener)
              scope.close()
            }),
        )
        const ctx = { ...ctxBase, rowLookup: acquired.scope.rowLookup, childIds: acquired.scope.childIds }
        const frames = Stream.fromQueue(queue).pipe(
          Stream.map((event) => liveEnvelopeFor(event, ctx)),
          Stream.filter((envelope): envelope is TimelineEnvelope => envelope !== null),
          Stream.map((envelope) => liveSseFrameBody(envelope)),
        )
        return HttpServerResponse.stream(frames.pipe(Stream.encodeText), {
          contentType: "text/event-stream",
          headers: { "X-Accel-Buffering": "no", "Cache-Control": "no-cache" },
        })
      }),
    )
  }),
)

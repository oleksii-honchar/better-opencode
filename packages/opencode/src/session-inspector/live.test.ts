import { describe, expect, test } from "bun:test"
import path from "path"
import { HttpServerResponse } from "effect/unstable/http"
import { partEnvelope } from "./timeline"
import type { PartRowView } from "./timeline"
import { liveEnvelopeFor, liveSseFrameBody, SESSION_INSPECTOR_LIVE_PATH } from "./live"
import { buildCategoryRouter } from "./category-mapper"
import { buildTimeline } from "./timeline"
import { insertMessage, insertPart, insertSession, makeFixtureSessionDb, tempDirs, GOLDEN_CATEGORY_IDS } from "./session-inspector.test-utils"
import { defaultInspectorConfig } from "./config.schema"
import type { SessionInspectorConfig } from "./config.schema"

// Task 6 — live tail pure core (§5.1-1 live bullet, §6.6 identical-shape requirement).
// OD-1 decision (recorded in evidence): SSE frames over the module's raw router; the
// frame body is ONE envelope JSON exactly as the NDJSON line bytes plus the SSE "data: "
// prefix — the one client parser stays valid for both channels.

const T = (iso: string) => Date.parse(iso)
const VIEW = "ses_live_view"

function makeWorld(): { dbPath: string; dirs: ReturnType<typeof tempDirs> } {
  const dirs = tempDirs()
  const dbPath = path.join(dirs.configDir, "fixture.db")
  makeFixtureSessionDb(dbPath)
  insertSession(dbPath, { id: VIEW, title: "live view", agent: "worker", timeCreated: T("2026-11-04T10:00:00Z"), timeUpdated: T("2026-11-04T10:00:00Z") })
  insertSession(dbPath, { id: "ses_live_child", title: "live child", agent: "worker", parentId: VIEW, timeCreated: T("2026-11-04T10:00:00Z"), timeUpdated: T("2026-11-04T10:00:00Z") })
  insertMessage(dbPath, { id: "msg_l1", sessionId: VIEW, timeCreated: T("2026-11-04T10:01:00Z"), role: "assistant" })
  return { dbPath, dirs }
}

function rowView(id: string, sessionId: string, timeCreated: number, data: Record<string, unknown>, msgData: string | null, rowid: number): PartRowView {
  return { id, session_id: sessionId, time_created: timeCreated, data: JSON.stringify(data), rowid, msg_data: msgData }
}

describe("partEnvelope — shared timeline/live envelope builder (byte identity by construction)", () => {
  test("timeline rows ARE produced by partEnvelope: same row through both paths gives identical bytes", () => {
    const world = makeWorld()
    const cfg = defaultInspectorConfig({ agentsRoot: world.dirs.agentsDir, logsDir: world.dirs.logsDir })
    insertPart(world.dbPath, { id: "prt_pair", messageId: "msg_l1", sessionId: VIEW, timeCreated: T("2026-11-04T10:02:00Z"), data: { type: "text", text: "fixture-pair body" } })

    const timeline = buildTimeline({ dbPath: world.dbPath, sessionId: VIEW, sessionPath: undefined, io: { readDir: () => undefined, read: () => undefined }, config: cfg, filters: {} })
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) throw new Error("timeline failed")
    const timelineLine = timeline.envelopes.find((e) => e.sourceRef.kind === "dbId" && e.sourceRef.dbId === "prt_pair")
    expect(timelineLine).toBeDefined()

    const router = buildCategoryRouter(cfg)
    const childIds = ["ses_live_child"] // fixture DB parent link
    const viaShared = partEnvelope(rowView("prt_pair", VIEW, T("2026-11-04T10:02:00Z"), { type: "text", text: "fixture-pair body" }, JSON.stringify({ role: "assistant" }), 1), router, new Set(childIds), cfg.limits.payloadCapBytes)
    expect(JSON.stringify(viaShared)).toBe(JSON.stringify(timelineLine))
  })
})

describe("liveEnvelopeFor — bus payload -> envelope (fixture pair, config-mapped events)", () => {
  const world = makeWorld()
  const cfg = defaultInspectorConfig({ agentsRoot: world.dirs.agentsDir, logsDir: world.dirs.logsDir })
  const router = buildCategoryRouter(cfg)
  const partRow = rowView("prt_live", VIEW, T("2026-11-04T10:03:00Z"), { type: "tool", tool: "bash", callID: "call_live", state: { status: "completed", input: {}, output: "ok" } }, JSON.stringify({ role: "assistant" }), 7)
  const ctx = {
    sessionId: VIEW,
    router,
    capBytes: cfg.limits.payloadCapBytes,
    // mirrors the projector: bus event carries part {id,messageID,sessionID,...rest}
    rowLookup: (id: string) => (id === partRow.id ? partRow : undefined),
    childIds: ["ses_live_child"] as readonly string[],
  }

  test("AC1 fixture-pair: PartUpdated envelope bytes == timeline line bytes for the same row (via rowLookup, never the event body)", () => {
    const env = liveEnvelopeFor({ id: "evt_1", type: "message.part.updated", properties: { sessionID: VIEW, time: partRow.time_created, part: { id: "prt_live", messageID: "msg_l1", sessionID: VIEW, type: "tool", tool: "bash", callID: "call_live", state: { status: "completed", input: {}, output: "ok" } } } }, ctx)
    expect(env).not.toBeNull()
    if (!env) return
    // strict 5-key envelope census (identical shape to NDJSON lines)
    expect(Object.keys(env).sort()).toEqual(["category", "payloadRef", "sourceRef", "summary", "ts"])
    expect(JSON.stringify(env)).toBe(JSON.stringify(partEnvelope(partRow, router, new Set(ctx.childIds), ctx.capBytes)))
  })

  test("PartRemoved -> dbId-keyed envelope (client removes cell by sourceRef.dbId; explicit removed marker)", () => {
    const env = liveEnvelopeFor({ id: "evt_2", type: "message.part.removed", properties: { sessionID: VIEW, messageID: "msg_l1", partID: "prt_live" } }, ctx)
    expect(env).not.toBeNull()
    if (!env) return
    expect(Object.keys(env).sort()).toEqual(["category", "payloadRef", "sourceRef", "summary", "ts"])
    expect(env.sourceRef.kind === "dbId" && env.sourceRef.dbId === "prt_live").toBe(true)
    expect(env.sourceRef).toMatchObject({ removed: true })
  })

  test("AC3: session.idle is config-mapped — default config has no matching historyEvents arm -> catch-all 'other'; payloadRef explicitly null", () => {
    const env = liveEnvelopeFor({ id: "evt_3", type: "session.idle", properties: { sessionID: VIEW } }, ctx)
    expect(env).not.toBeNull()
    if (!env) return
    expect(["other"]).toContain(env.category) // catch-all both arms per Task-4
    expect(env.payloadRef).toBeNull() // no payload source for a bare event; drawer says so explicitly
  })

  test("AC3: a config column declaring the live event name wins (config decides, SC-2)", () => {
    const cols = cfg.categories.map((c) => ({ ...c }))
    const pipeline = cols.find((c) => c.id === "pipeline")
    expect(pipeline).toBeDefined()
    if (!pipeline) return
    pipeline.sources = { ...pipeline.sources, historyEvents: [...(pipeline.sources.historyEvents ?? []), "session.idle", "permission.asked"] }
    const mapped: SessionInspectorConfig = { ...cfg, categories: cols }
    const mappedRouter = buildCategoryRouter(mapped)
    const mappedCtx = { ...ctx, router: mappedRouter }
    const idle = liveEnvelopeFor({ id: "evt_4", type: "session.idle", properties: { sessionID: VIEW } }, mappedCtx)
    expect(idle?.category).toBe("pipeline")
    const asked = liveEnvelopeFor({ id: "evt_5", type: "permission.asked", properties: { sessionID: VIEW, id: "per_1", pattern: "bash" } }, mappedCtx)
    expect(asked?.category).toBe("pipeline")
    expect(asked?.payloadRef).toBeNull()
  })

  test("scope filter: foreign session events produce nothing; child-session parts pass with db-parent lineage like timeline", () => {
    expect(liveEnvelopeFor({ id: "evt_x", type: "session.idle", properties: { sessionID: "ses_not_in_scope" } }, ctx)).toBeNull()
    const childRow = rowView("prt_c1", "ses_live_child", T("2026-11-04T10:04:00Z"), { type: "text", text: "child part" }, JSON.stringify({ role: "assistant" }), 9)
    const childCtx = { ...ctx, rowLookup: (id: string) => (id === "prt_c1" ? childRow : undefined) }
    const env = liveEnvelopeFor({ id: "evt_y", type: "message.part.updated", properties: { sessionID: "ses_live_child", time: childRow.time_created, part: { id: "prt_c1", messageID: "msg_c1", sessionID: "ses_live_child", type: "text", text: "child part" } } }, childCtx)
    expect(env).not.toBeNull()
    if (!env) return
    expect(env.sourceRef).toMatchObject({ kind: "dbId", dbId: "prt_c1", lineage: "db-parent" })
  })

  test("unknown event types are ignored (not silently mapped): returns null", () => {
    expect(liveEnvelopeFor({ id: "evt_z", type: "session.updated", properties: { sessionID: VIEW } }, ctx)).toBeNull()
  })
})

describe("liveSseFrameBody + route surface", () => {
  test("SSE frame body is exactly 'data: ' + the NDJSON line bytes + frame separators (one client parser)", async () => {
    const env = { category: "other", ts: "2026-11-04T10:05:00.000Z", sourceRef: { kind: "dbId" as const, dbId: "x", sessionId: "ses_x" }, summary: "s", payloadRef: null }
    const frame = liveSseFrameBody(env)
    expect(frame).toBe(`data: ${JSON.stringify(env)}\n\n`)
  })

  test("live route path constant is the spec URL and passes the trie-normalization rule", () => {
    expect(SESSION_INSPECTOR_LIVE_PATH).toBe("/session-inspector/session/:sessionID/live")
    expect(SESSION_INSPECTOR_LIVE_PATH.replace(/\/$/, "")).not.toBe("/session-inspector/session/:sessionID/timeline")
  })
})

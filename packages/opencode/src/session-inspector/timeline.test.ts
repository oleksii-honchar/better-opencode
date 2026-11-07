import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "path"
import { buildTimeline, EXCLUDED_EVENT_TYPES, partEnvelope } from "./timeline"
import { buildCategoryRouter } from "./category-mapper"
import type { TimelineEnvelope } from "./timeline"
import { resolvePayload } from "./payload"
import { defaultInspectorConfig } from "./config.schema"
import type { SessionInspectorConfig } from "./config.schema"
import {
  insertMessage,
  insertPart,
  insertSession,
  judgeRecordV11,
  makeFixtureSessionDb,
  historyLine,
  nodeScanIO,
  tempDirs,
  writeJudgeRecords,
  writeSessionFolder,
} from "./session-inspector.test-utils"

// Task 4 — the join contract. Single shared fixture family: a parent session viewed with DB
// parts (typed rows incl. deliberate ties/roles), a v2.3 history.jsonl (base vocabulary +
// persona.transition with stringified details per DEC-L + TRN alias + plugin.nudge with
// ref_part_id + unknown name + CORRUPT middle line + lineage-keyed lines), two child sessions
// (one DB-linked via parent_id, one history-keys-only), and a legacy judge-records.jsonl.
// Part data objects mirror REAL store shapes measured 2026-11-03 (text/reasoning/tool/step-*)
// for realism only — no live-store counts are asserted anywhere.

const T0 = "2026-11-03T09:00:00.000Z"
const T_USER = "2026-11-03T09:00:01.000Z"
const T_TRANS = "2026-11-03T09:00:02.000Z"
const T_TIE_DB1 = "2026-11-03T10:00:00.500Z"
const T_TIE_DB2 = "2026-11-03T10:00:00.500Z"
const T_TIE_H1 = "2026-11-03T10:00:00.500Z"
const T_TIE_H2 = "2026-11-03T10:00:00.500Z"
const T_TOOL = "2026-11-03T10:00:05.000Z"
const T_STEP = "2026-11-03T10:00:06.000Z"
const T_UNKNOWN_PART = "2026-11-03T10:00:07.000Z"
const T_TRN = "2026-11-03T10:00:08.000Z"
const T_NUDGE = "2026-11-03T10:00:09.000Z"
const T_FUTURE = "2026-11-03T10:00:10.000Z"
const T_CORRUPT_AFTER = "2026-11-03T10:00:11.000Z"
const T_SUB_DB = "2026-11-03T10:00:12.000Z"
const T_SUB_ORPHAN = "2026-11-03T10:00:13.000Z"
const T_JUDGE = "2026-11-03T10:00:04.500Z"

const VIEW = "ses_t4_view"
const CHILD_DB = "ses_t4_child_db"
const ORPHAN = "ses_t4_orphan"

const ms = (iso: string): number => Date.parse(iso)

interface Fixture {
  dbPath: string
  folder: string
  logsDir: string
  cleanup: () => void
  config: SessionInspectorConfig
}

function timelineFixture(options: { noJudgeFile?: boolean; noHistory?: boolean } = {}): Fixture {
  const dirs = tempDirs()
  const dbPath = path.join(dirs.configDir, "engine.db")
  makeFixtureSessionDb(dbPath)
  insertSession(dbPath, { id: VIEW, title: "Viewed session", timeCreated: ms(T0), timeUpdated: ms(T_SUB_DB) })
  insertSession(dbPath, { id: CHILD_DB, title: "DB-linked child", timeCreated: ms(T0), timeUpdated: ms(T_SUB_DB), parentId: VIEW })
  insertSession(dbPath, { id: ORPHAN, title: "History-linked only", timeCreated: ms(T0), timeUpdated: ms(T_SUB_ORPHAN) })

  insertMessage(dbPath, { id: "msg_u", sessionId: VIEW, timeCreated: ms(T_USER), role: "user" })
  insertMessage(dbPath, { id: "msg_a", sessionId: VIEW, timeCreated: ms(T_TIE_DB1), role: "assistant" })
  insertMessage(dbPath, { id: "msg_l", sessionId: VIEW, timeCreated: ms(T_TOOL), role: "assistant" })
  insertMessage(dbPath, { id: "msg_c", sessionId: CHILD_DB, timeCreated: ms(T_SUB_DB), role: "assistant" })
  insertMessage(dbPath, { id: "msg_o", sessionId: ORPHAN, timeCreated: ms(T_SUB_ORPHAN), role: "assistant" })

  // parts (insertion order == rowid order: tie_1 strictly before tie_2)
  insertPart(dbPath, { id: "prt_tie_1", messageId: "msg_a", sessionId: VIEW, timeCreated: ms(T_TIE_DB1), data: { type: "text", text: "tie db first" } })
  insertPart(dbPath, { id: "prt_tie_2", messageId: "msg_a", sessionId: VIEW, timeCreated: ms(T_TIE_DB2), data: { type: "reasoning", text: "tie db second", time: 5 } })
  insertPart(dbPath, { id: "prt_user", messageId: "msg_u", sessionId: VIEW, timeCreated: ms(T_USER), data: { type: "text", text: "hello inspector world" } })
  insertPart(dbPath, {
    id: "prt_tool",
    messageId: "msg_l",
    sessionId: VIEW,
    timeCreated: ms(T_TOOL),
    data: { type: "tool", tool: "bash", callID: "call_t4_enrich", state: { status: "completed", input: { command: "echo hi" }, output: "hi" } },
  })
  // NAMED DELTA (AD18): the lifecycle POSITIVE path re-anchors to a non-excluded kind (patch —
  // card: "so the lifecycle positive path STAYS tested"). prt_step keeps its id (golden order stable).
  insertPart(dbPath, { id: "prt_step", messageId: "msg_l", sessionId: VIEW, timeCreated: ms(T_STEP), data: { type: "patch", snapshot: "abc123" } })
  // AD18 exclusion contract: these JOIN-STEPS exist in the DB but must surface NOWHERE in any column:
  insertPart(dbPath, { id: "prt_excl_a", messageId: "msg_l", sessionId: VIEW, timeCreated: ms(T_STEP) + 1, data: { type: "step-start", snapshot: "def456" } })
  insertPart(dbPath, { id: "prt_excl_b", messageId: "msg_l", sessionId: VIEW, timeCreated: ms(T_STEP) + 2, data: { type: "step-finish", reason: "model-stop" } })
  insertPart(dbPath, { id: "prt_unk_part", messageId: "msg_l", sessionId: VIEW, timeCreated: ms(T_UNKNOWN_PART), data: { type: "quantum-flux", payload: [1, 2, 3] } })
  insertPart(dbPath, { id: "prt_child", messageId: "msg_c", sessionId: CHILD_DB, timeCreated: ms("2026-11-03T10:00:12.500Z"), data: { type: "text", text: "child output" } })
  insertPart(dbPath, { id: "prt_orphan", messageId: "msg_o", sessionId: ORPHAN, timeCreated: ms(T_SUB_ORPHAN), data: { type: "text", text: "orphan output" } })

  // session folder — history.jsonl written in this exact file order (byte order is contract)
  const folder = path.join(dirs.agentsDir, "fixture", VIEW)
  mkdirSync(folder, { recursive: true })
  writeSessionFolder(folder, { sessionId: VIEW, noHistory: true })
  if (!options.noHistory) {
    const lines = [
      historyLine({ ts: T0, sessionId: VIEW, agent: "developer", event: "started", nextAgent: "worker", phase: "implementation", status: null }),
      // tie lines for T_TIE_* (file order H1 before H2)
      historyLine({ ts: T_TIE_H1, sessionId: VIEW, agent: "worker", event: "handoff", nextAgent: "worker", phase: null, status: null }),
      historyLine({ ts: T_TIE_H2, sessionId: VIEW, agent: "worker", event: "completed", phase: "implementation", status: "done" }),
      // transition with DEC-L stringified details AND an unmodeled extra top-level key (reader must ignore, not fail)
      JSON.stringify({
        ts: T_TRANS,
        sessionId: VIEW,
        agent: "worker",
        event: "persona.transition",
        details: JSON.stringify({ node_id: "20-tdd/10-red-tests", edge_when: "tests fail", target_node: "20-tdd/20-green", occurred_at: T_TRANS, node_enter_context: "x", memory_id: null, bank: "agent-persona_worker" }),
        nextAgent: null,
        phase: null,
        status: null,
        futureTopLevelKey: 7,
      }),
      historyLine({ ts: T_TRN, sessionId: VIEW, agent: "worker", event: "TRN", details: JSON.stringify({ node_id: "a/one", target_node: "b/two", occurred_at: T_TRN }) }),
      historyLine({ ts: T_NUDGE, sessionId: VIEW, agent: "engine", event: "plugin.nudge", details: JSON.stringify({ emitter: "SessionReminders", kind: "scaffold-reminder", injected_bytes: 128, ref_part_id: "prt_nudge_target" }) }),
      historyLine({ ts: T_FUTURE, sessionId: VIEW, agent: "who-knows", event: "some.future_event", details: "plain text details" }),
      "this line is { not json at all {{{",
      historyLine({ ts: T_CORRUPT_AFTER, sessionId: VIEW, agent: "coach", event: "agent.coach", details: JSON.stringify({ category: "traversal", action: "inject", injected_bytes: 512 }) }),
      // lineage: child WITH db parent_id link (db arm wins)
      historyLine({ ts: T_SUB_DB, sessionId: VIEW, agent: "worker", event: "agent.coach", details: null, subAgentSessionId: CHILD_DB, parentSessionId: VIEW }),
      // lineage: child WITHOUT any db link (history-keys arm only)
      historyLine({ ts: T_SUB_ORPHAN, sessionId: VIEW, agent: "worker", event: "agent.coach", details: null, subAgentSessionId: ORPHAN, parentSessionId: VIEW }),
    ]
    writeFileSync(path.join(folder, "history.jsonl"), lines.map((l) => l + "\n").join(""))
  }
  if (!options.noJudgeFile) {
    writeJudgeRecords(folder, [
      judgeRecordV11({
        v: 11,
        sid: VIEW,
        seq: 41,
        ts: T_JUDGE,
        kind: "entry",
        node: "20-tdd",
        backend: "litellm:x",
        model: "m1",
        request: { prompt: "r1" },
        answer: { score: 0.9 },
      }),
      judgeRecordV11({
        v: 11,
        sid: VIEW,
        seq: 42,
        ts: "2026-11-03T10:00:04.700Z",
        kind: "realign",
        node: "20-tdd",
        backend: "litellm:x",
        model: null,
        request: { prompt: "r2" },
        answer: { score: 0.4 },
        error: { stage: "parse", detail: "malformed" },
      }),
    ])
  }

  const config = defaultInspectorConfig({ agentsRoot: dirs.agentsDir, logsDir: dirs.logsDir })
  const withDb: SessionInspectorConfig = { ...config, paths: { ...config.paths, dbMode: dbPath } }
  return { dbPath, folder, logsDir: dirs.logsDir, cleanup: dirs.cleanup, config: withDb }
}

function run(fixture: Fixture, filters: { from?: string; to?: string; categories?: string[] } = {}) {
  const result = buildTimeline({
    dbPath: fixture.dbPath,
    sessionId: VIEW,
    sessionPath: fixture.folder,
 io: nodeScanIO(),
    config: fixture.config,
    filters,
  })
  if (!result.ok) throw new Error(`timeline failed: ${result.code} ${result.message}`)
  return result.envelopes
}

// AD18 (owner 2026-11-05: "remove from lifecycle col step-start and step-finish - they are
// not informative at all") — JOIN-step exclusion BEFORE category routing: zero rows under ANY
// category config (config-deletion was rejected: the unmatched-fallback would relocate the
// noise to Other — the opposite of the ask). DB rows stay (read-side only; counts honest).
describe("ad18 join-step exclusion — step-start/step-finish surface in NO column, under ANY config", () => {
  const stepIds = (es: TimelineEnvelope[]) =>
    es.filter((e) => e.sourceRef.kind === "dbId" && ["prt_excl_a", "prt_excl_b"].includes((e.sourceRef as { dbId: string }).dbId))
  test("default config: zero step rows anywhere (lifecycle empty of them, OTHER never receives them)", () => {
    const fixture = timelineFixture()
    try {
      const es = run(fixture)
      expect(stepIds(es).length).toBe(0)
      expect(es.some((e) => (e.sourceRef as { dbId?: string }).dbId === "prt_step")).toBe(true) // patch part unaffected — sibling kinds byte-unchanged
    } finally {
      fixture.cleanup()
    }
  })
  test("ANY category config cannot resurrect them: lifecycle-deleted config AND a custom column claiming step parts both yield zero rows", () => {
    const fixture = timelineFixture()
    try {
      const noLifecycle: SessionInspectorConfig = { ...fixture.config, categories: fixture.config.categories.filter((c) => c.id !== "lifecycle") }
      const claimSteps: SessionInspectorConfig = {
        ...fixture.config,
        categories: [
          ...fixture.config.categories,
          { id: "steps-claimed", title: "Claimed", order: 20, sources: { parts: ["step-start", "step-finish"] }, enabled: true },
        ],
      }
      for (const cfg of [noLifecycle, claimSteps]) {
        const r = buildTimeline({ dbPath: fixture.dbPath, sessionId: VIEW, sessionPath: fixture.folder, io: nodeScanIO(), config: cfg, filters: {} })
        if (!r.ok) throw new Error("timeline failed: " + r.code)
        expect(stepIds(r.envelopes).length).toBe(0) // not Other in config-1, not steps-claimed in config-2
      }
    } finally {
      fixture.cleanup()
    }
  })
  test("EXCLUDED_EVENT_TYPES is a named, owner-commented constant (the toggle if ever re-wanted)", () => {
    expect(EXCLUDED_EVENT_TYPES).toEqual(["step-start", "step-finish"])
    const src = require("node:fs").readFileSync(new URL("./timeline.ts", import.meta.url), "utf8") as string
    // Checker anchor fix (during GREEN): the owner comment PRECEDES the export, so the slice
    // window is taken from the declaration backwards incl. the comment header. Pin intent —
    // "the directive is recorded AT the constant" — unchanged.
    const idx = src.indexOf("export const EXCLUDED_EVENT_TYPES")
    const decl = src.slice(Math.max(0, idx - 500), idx + 300)
    expect(decl).toMatch(/not informative/i) // owner directive recorded at the constant, per card
    expect(decl).toMatch(/2026-11-05/)
  })
})

describe("timeline join — ordering, interleaving, ties (AC1)", () => {
  test("golden stream order: ts asc; within-ms ties resolve DB-by-rowid then history-by-byte-order; corrupt line skipped without aborting", () => {
    const fixture = timelineFixture()
    try {
      const envelopes = run(fixture)
      const idOf = (e: TimelineEnvelope): string =>
        e.sourceRef.kind === "dbId" ? e.sourceRef.dbId : `line:${e.category}:${(e.sourceRef as { line?: number }).line ?? "?"}`
      // exactly this sequence of (source) rows in this order — independently authored from the
      // fixture spec above. line numbers are 1-based PHYSICAL file lines (payload resolution
      // contract); the corrupt physical line 8 is absent and lines 9+ keep their physical numbers.
      expect(envelopes.map(idOf)).toEqual([
        "line:pipeline:1", // T0 history started — interleaves BEFORE db content
        "prt_user", // 09:00:01
        "line:transitions:4", // 09:00:02 persona.transition
        "prt_tie_1", // same ms 10:00:00.500 — DB rows first, insert order
        "prt_tie_2",
        "line:pipeline:2", // then history lines in FILE order
        "line:pipeline:3",
        "line:coach-judge:1", // 10:00:04.5 legacy judge auto-detect (judge file line 1)
        "line:coach-judge:2",
        "prt_tool",
        "prt_step",
        "prt_unk_part", // unknown part type visible
        "line:transitions:5", // TRN alias
        "line:engine-nudges:6",
        "line:other:7", // unknown event name
        // physical history line 8 (corrupt) is skipped; stream continues:
        "line:coach-activity:9",
        "line:coach-activity:10", // subagent line (db-linked child)
        "prt_child", // folded under parent view
        "line:coach-activity:11", // subagent line (history-keys-only child)
      ])
      // orphan session's DB parts must NOT fold (history keys alone carry no db parts):
      expect(envelopes.some((e) => e.sourceRef.kind === "dbId" && e.sourceRef.dbId === "prt_orphan")).toBe(false)
      // AD18 (owner: "not informative at all"): the step parts are IN the DB (counts honest,
      // source untouched) and surface in NO column — not lifecycle, not other (evaluated here).
      for (const gone of ["prt_excl_a", "prt_excl_b"]) {
        expect(envelopes.some((e) => e.sourceRef.kind === "dbId" && e.sourceRef.dbId === gone)).toBe(false)
      }
      // envelope shape: EXACTLY five keys per row, in order.
      // NAMED CONTRACT UPDATE (AD22): reasoning rows carry a SIXTH key contentChars, appended
      // LAST; every other category keeps the strict five (the ad22 join lane pins both sides).
      // NAMED CONTRACT UPDATE (AD27): lifecycle rows may carry a SIXTH key partType (the three
      // visible kinds only) appended LAST — same sanctioned pattern; this golden stream contains
      // no lifecycle part rows, so the else-branch stays strict here (the ad27 join lane pins
      // the positive side against the real function).
      for (const e of envelopes) {
        const base = ["category", "ts", "sourceRef", "summary", "payloadRef"]
        expect(Object.keys(e)).toEqual(e.category === "reasoning" ? [...base, "contentChars"] : e.category === "lifecycle" ? [...base, "partType"] : base)
      }
      // every line is self-contained JSON with a valid ts
      for (const e of envelopes) expect(Number.isNaN(Date.parse(e.ts))).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test("filters: from/to bound the window (inclusive); categories restricts the stream; invalid filter values are reported, not thrown", () => {
    const fixture = timelineFixture()
    try {
      const window = run(fixture, { from: "2026-11-03T10:00:04.000Z", to: "2026-11-03T10:00:05.000Z" })
      const dbIds = window.filter((e) => e.sourceRef.kind === "dbId").map((e) => (e.sourceRef as { dbId: string }).dbId)
      expect(dbIds).toEqual(["prt_tool"])
      const lifecycleOnly = run(fixture, { categories: ["lifecycle"] })
      expect(lifecycleOnly.every((e) => e.category === "lifecycle")).toBe(true)
      expect(lifecycleOnly.length).toBe(1) // RE-ANCHORED (AD18): the ONE lifecycle row is the patch part — the positive path stays tested
      const bad = buildTimeline({
        dbPath: fixture.dbPath,
        sessionId: VIEW,
        sessionPath: fixture.folder,
 io: nodeScanIO(),
        config: fixture.config,
        filters: { from: "not-a-date" },
      })
      expect(bad.ok).toBe(false)
      if (!bad.ok) expect(bad.code).toBe("INVALID_FILTER")
      const badCat = buildTimeline({
        dbPath: fixture.dbPath,
        sessionId: VIEW,
        sessionPath: fixture.folder,
 io: nodeScanIO(),
        config: fixture.config,
        filters: { categories: ["no-such-column"] },
      })
      expect(badCat.ok).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })
})

describe("timeline join — categories, badges, DEC-L details, lineage arms (AC2/AC3)", () => {
  test("transitions rows (persona.transition AND TRN alias) carry bankAuthoritative badge; summary comes from JSON-PARSED details string; extra top-level keys do not break the row", () => {
    const fixture = timelineFixture()
    try {
      const envelopes = run(fixture)
      const transitions = envelopes.filter((e) => e.category === "transitions")
      expect(transitions.length).toBe(2)
      for (const e of transitions) {
        expect(e.sourceRef.kind).toBe("historyLine")
        expect((e.sourceRef as { bankAuthoritative?: boolean }).bankAuthoritative).toBe(true)
      }
      // summary built FROM the parsed details carrier (DEC-L), not from the raw string
      expect(transitions[0].summary).toContain("20-tdd/10-red-tests")
      expect(transitions[0].summary).toContain("20-tdd/20-green")
      expect(transitions[0].summary).not.toContain('\\"node_id\\"') // not the double-encoded raw carrier
      // TRN alias lands in the SAME category
      expect(transitions[1].summary).toContain("a/one")
    } finally {
      fixture.cleanup()
    }
  })

  test("engine-nudges rows carry ref_part_id in sourceRef", () => {
    const fixture = timelineFixture()
    try {
      const nudges = run(fixture).filter((e) => e.category === "engine-nudges")
      expect(nudges.length).toBe(1)
      expect((nudges[0].sourceRef as { ref_part_id?: string }).ref_part_id).toBe("prt_nudge_target")
    } finally {
      fixture.cleanup()
    }
  })

  test("lineage fold — both arms: DB parent_id is primary when both exist; history keys used when DB lacks the link", () => {
    const fixture = timelineFixture()
    try {
      const envelopes = run(fixture)
      const childPart = envelopes.find((e) => e.sourceRef.kind === "dbId" && (e.sourceRef as { dbId?: string }).dbId === "prt_child")
      expect(childPart).toBeDefined()
      expect((childPart!.sourceRef as { lineage?: string; sessionId?: string }).lineage).toBe("db-parent")
      expect((childPart!.sourceRef as { sessionId?: string }).sessionId).toBe(CHILD_DB)

      const subDbLine = envelopes.find((e) => e.sourceRef.kind === "historyLine" && (e.sourceRef as { sessionId?: string }).sessionId === CHILD_DB)
      expect(subDbLine).toBeDefined()
      // both exist → db arm marks it
      expect((subDbLine!.sourceRef as { lineage?: string }).lineage).toBe("db-parent")

      const subOrphanLine = envelopes.find((e) => e.sourceRef.kind === "historyLine" && (e.sourceRef as { sessionId?: string }).sessionId === ORPHAN)
      expect(subOrphanLine).toBeDefined()
      expect((subOrphanLine!.sourceRef as { lineage?: string }).lineage).toBe("history-subagent")

      // own rows carry no lineage marker
      const own = envelopes.find((e) => e.sourceRef.kind === "dbId" && (e.sourceRef as { dbId?: string }).dbId === "prt_user")
      expect(own).toBeDefined()
      expect(own!.sourceRef).not.toHaveProperty("lineage")
    } finally {
      fixture.cleanup()
    }
  })

  test("legacy judge fixture auto-detected by file presence renders under configured coach-judge column; absent file → no judge rows (never invented)", () => {
    const withJudge = timelineFixture()
    let envelopes: TimelineEnvelope[] = []
    try {
      envelopes = run(withJudge)
    } finally {
      withJudge.cleanup()
    }
    const judges = envelopes.filter((e) => e.category === "coach-judge")
    expect(judges.length).toBe(2)

    const without = timelineFixture({ noJudgeFile: true })
    try {
      const none = run(without)
      expect(none.some((e) => e.category === "coach-judge")).toBe(false)
    } finally {
      without.cleanup()
    }
  })
})

describe("timeline payloadRef — kinds and truncation flags (part of AC5)", () => {
  test("payloadRef encodes resolver kind and id for both source kinds", () => {
    const fixture = timelineFixture()
    try {
      const envelopes = run(fixture)
      const db = envelopes.find((e) => e.sourceRef.kind === "dbId")!
      expect(db.payloadRef).toMatchObject({ kind: "dbId", dbId: (db.sourceRef as { dbId: string }).dbId })
      const history = envelopes.find((e) => e.sourceRef.kind === "historyLine")!
      expect(history.payloadRef).toMatchObject({ kind: "historyLine", file: "history.jsonl" })
      expect(typeof (history.payloadRef as { line?: number }).line).toBe("number")
    } finally {
      fixture.cleanup()
    }
  })

  test("oversized payload under config cap: envelope payloadRef carries {truncated:true, fullLength} — never silent", () => {
    const fixture = timelineFixture()
    try {
      const smallCap: SessionInspectorConfig = {
        ...fixture.config,
        limits: { ...fixture.config.limits, payloadCapBytes: 32 },
      }
      const result = buildTimeline({
        dbPath: fixture.dbPath,
        sessionId: VIEW,
        sessionPath: fixture.folder,
 io: nodeScanIO(),
        config: smallCap,
        filters: {},
      })
      if (!result.ok) throw new Error("timeline failed")
      const user = result.envelopes.find((e) => e.sourceRef.kind === "dbId" && (e.sourceRef as { dbId: string }).dbId === "prt_user")!
      const rawBytes = Buffer.byteLength(JSON.stringify({ type: "text", text: "hello inspector world" }), "utf8")
      expect(user.payloadRef).toEqual({ kind: "dbId", dbId: "prt_user", truncated: true, fullLength: rawBytes })
      // tiny-cap scenario: EVERY over-cap source row carries the flags uniformly (no silent class)
      for (const e of result.envelopes.filter((row) => row.sourceRef.kind === "historyLine")) {
        expect(e.payloadRef).toMatchObject({ truncated: true })
        expect(typeof (e.payloadRef as { fullLength?: number }).fullLength).toBe("number")
      }
      // default-cap run (fixture.config, 256 KiB): nothing truncates and NO truncation keys at all
      const normal = buildTimeline({
        dbPath: fixture.dbPath,
        sessionId: VIEW,
        sessionPath: fixture.folder,
        io: nodeScanIO(),
        config: fixture.config,
        filters: {},
      })
      if (!normal.ok) throw new Error("timeline failed")
      for (const e of normal.envelopes) expect(e.payloadRef).not.toHaveProperty("truncated")
    } finally {
      fixture.cleanup()
    }
  })
})

describe("timeline IO failures (Result-style)", () => {
  test("unreadable DB returns a failure value; nothing thrown; missing sessionPath degrades to DB-only stream", () => {
    const fixture = timelineFixture()
    try {
      const missing = path.join(fixture.folder, "..", "definitely-not-here.db")
      const result = buildTimeline({ dbPath: missing, sessionId: VIEW, sessionPath: fixture.folder, io: nodeScanIO(), config: fixture.config, filters: {} })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe("DB_UNREADABLE")

      const noFolder = buildTimeline({ dbPath: fixture.dbPath, sessionId: VIEW, sessionPath: undefined, io: nodeScanIO(), config: fixture.config, filters: {} })
      if (!noFolder.ok) throw new Error("timeline failed")
      expect(noFolder.envelopes.length).toBeGreaterThan(0)
      expect(noFolder.envelopes.every((e) => e.sourceRef.kind === "dbId")).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test("empty history file and missing judge file are ordinary states", () => {
    const fixture = timelineFixture({ noJudgeFile: true, noHistory: true })
    try {
      expect(existsSync(path.join(fixture.folder, "history.jsonl"))).toBe(false)
      const envelopes = run(fixture)
      expect(envelopes.every((e) => e.sourceRef.kind === "dbId")).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })
})

// -- Task 4b — engine-nudges synthetic-part fallback rows ----------------------
// Real marker measured 2026-11-03 against the live store + message-v2.ts:102:
// optional BOOLEAN `synthetic` on text part data ({type:"text", text, synthetic:true});
// absence means not synthetic; NO false values in 13 739 real rows. Spec shorthand
// `synthetic: true` matches the real schema exactly.

const SB = "ses_t4b_view"

function t4bFixture(options: { withoutNudgesColumn?: boolean } = {}) {
  const dirs = tempDirs()
  const dbPath = path.join(dirs.configDir, "engine.db")
  makeFixtureSessionDb(dbPath)
  insertSession(dbPath, { id: SB, title: "4b view", timeCreated: 1000, timeUpdated: 5000 })
  insertMessage(dbPath, { id: "msg_su", sessionId: SB, timeCreated: 1000, role: "user" })
  insertMessage(dbPath, { id: "msg_sa", sessionId: SB, timeCreated: 3000, role: "assistant" })
  // synthetic parts ride USER messages in the real store (reminders append nudge parts there)
  insertPart(dbPath, { id: "prt_synth_free", messageId: "msg_su", sessionId: SB, timeCreated: 1000, data: { type: "text", text: "unmet-contract reminder body", synthetic: true } })
  insertPart(dbPath, { id: "prt_synth_hit", messageId: "msg_su", sessionId: SB, timeCreated: 2000, data: { type: "text", text: "SCAFFOLD_NUDGE attributed body", synthetic: true } })
  insertPart(dbPath, { id: "prt_plain", messageId: "msg_sa", sessionId: SB, timeCreated: 3000, data: { type: "text", text: "ordinary assistant answer" } })

  const folder = path.join(dirs.agentsDir, "t4b", SB)
  writeSessionFolder(folder, {
    sessionId: SB,
    noHistory: true,
  })
  const nudged = (ref: string): string =>
    historyLine({ ts: "2026-11-03T10:00:0" + (ref === "prt_synth_hit" ? "2.000Z" : "4.000Z"), sessionId: SB, agent: "engine", event: "plugin.nudge", details: JSON.stringify({ emitter: "SessionReminders", kind: "scaffold-reminder", injected_bytes: 30, ref_part_id: ref }) })
  writeFileSync(path.join(folder, "history.jsonl"), [nudged("prt_synth_hit"), nudged("prt_ghost")].map((l) => l + "\n").join(""))

  const base = defaultInspectorConfig({ agentsRoot: dirs.agentsDir, logsDir: dirs.logsDir })
  const categories = options.withoutNudgesColumn
    ? base.categories.filter((c) => c.id !== "engine-nudges") // deliberate local scenario — simulates a config lane WITHOUT the column
    : base.categories
  const config: SessionInspectorConfig = { ...base, categories, paths: { ...base.paths, dbMode: dbPath } }
  return { dbPath, folder, cleanup: dirs.cleanup, config }
}

function run4b(fixture: ReturnType<typeof t4bFixture>): TimelineEnvelope[] {
  const result = buildTimeline({ dbPath: fixture.dbPath, sessionId: SB, sessionPath: fixture.folder, io: nodeScanIO(), config: fixture.config, filters: {} })
  if (!result.ok) throw new Error(`timeline failed: ${result.code} ${result.message}`)
  return result.envelopes
}

describe("engine-nudges synthetic fallback rows (Task 4b)", () => {
  test("unattributed synthetic text part yields an engine-nudges row marked attributed:false with the part id in sourceRef.dbId; /payload resolves its full text", () => {
    const fixture = t4bFixture()
    try {
      const envelopes = run4b(fixture)
      const fallbacks = envelopes.filter((e) => e.category === "engine-nudges" && e.sourceRef.kind === "dbId")
      expect(fallbacks.map((e) => (e.sourceRef as { dbId: string }).dbId)).toEqual(["prt_synth_free"])
      const fb = fallbacks[0]!
      expect((fb.sourceRef as { attributed?: boolean }).attributed).toBe(false)
      expect(fb.payloadRef).toMatchObject({ kind: "dbId", dbId: "prt_synth_free" })
      // envelope stays the strict five keys
      expect(Object.keys(fb)).toEqual(["category", "ts", "sourceRef", "summary", "payloadRef"])
      // drawer contract: the ratified /payload pointer resolution returns the FULL text
      const payload = resolvePayload({
        dbPath: fixture.dbPath,
        sessionId: SB,
        sessionPath: fixture.folder,
        io: nodeScanIO(),
        config: fixture.config,
        ref: { kind: "dbId", dbId: "prt_synth_free" },
      })
      expect(payload.resolved).toBe(true)
      expect((payload.payload as { text: string }).text).toBe("unmet-contract reminder body")
      expect(payload.truncated).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test("plugin.nudge line with matching ref_part_id SUPPRESSES the fallback row — attributed row wins with attributed:true, never duplicated", () => {
    const fixture = t4bFixture()
    try {
      const envelopes = run4b(fixture)
      // the paired part appears exactly ONCE across the whole stream — as the attributed nudge row
      const representing = envelopes.filter(
        (e) =>
          (e.sourceRef.kind === "dbId" && (e.sourceRef as { dbId: string }).dbId === "prt_synth_hit") ||
          (e.sourceRef.kind === "historyLine" && (e.sourceRef as { ref_part_id?: string }).ref_part_id === "prt_synth_hit"),
      )
      expect(representing.length).toBe(1)
      const attributed = representing[0]!
      expect(attributed.category).toBe("engine-nudges")
      expect((attributed.sourceRef as { attributed?: boolean }).attributed).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test("nudge line whose ref_part_id matches no part stands alone — no phantom fallback row", () => {
    const fixture = t4bFixture()
    try {
      const envelopes = run4b(fixture)
      const ghost = envelopes.filter((e) => (e.sourceRef as { ref_part_id?: string }).ref_part_id === "prt_ghost")
      expect(ghost.length).toBe(1)
      expect(ghost[0]!.category).toBe("engine-nudges")
      expect(ghost[0]!.sourceRef.kind).toBe("historyLine")
      expect((ghost[0]!.sourceRef as { attributed?: boolean }).attributed).toBe(true)
      // and no dbId-sourced row was invented for the ghost id
      expect(envelopes.some((e) => e.sourceRef.kind === "dbId" && (e.sourceRef as { dbId: string }).dbId === "prt_ghost")).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test("no engine-nudges column in config → synthetic fallback rows exist NOWHERE; the parts stay visible as ordinary text rows (never vanish)", () => {
    const fixture = t4bFixture({ withoutNudgesColumn: true })
    try {
      const envelopes = run4b(fixture)
      expect(envelopes.some((e) => e.category === "engine-nudges")).toBe(false)
      expect(envelopes.some((e) => "attributed" in e.sourceRef)).toBe(false)
      // degrade visibly: the synthetic parts still render through normal part mapping
      const synthFree = envelopes.find((e) => e.sourceRef.kind === "dbId" && (e.sourceRef as { dbId: string }).dbId === "prt_synth_free")
      expect(synthFree).toBeDefined()
      expect(synthFree!.category).toBe("user-messages")
    } finally {
      fixture.cleanup()
    }
  })

  test("ordinary (non-synthetic) parts carry no attribution marker and keep their configured column", () => {
    const fixture = t4bFixture()
    try {
      const plain = run4b(fixture).find((e) => e.sourceRef.kind === "dbId" && (e.sourceRef as { dbId: string }).dbId === "prt_plain")
      expect(plain).toBeDefined()
      expect(plain!.category).toBe("assistant-text")
      expect(plain!.sourceRef).not.toHaveProperty("attributed")
    } finally {
      fixture.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AD22 — reasoning rows carry their EXACT content length, computed in the READ JOIN
// (owner: NNNk labels; developer-bound: never measure from the byte-capped payload
// endpoint). The join loads the uncapped p.data (no SQL substr anywhere) — verified —
// so NO F-CODE is needed for capability. F-CODE (premise): the card claims zero-text
// reasoning emits no cell; the PART channel has no such drop (only history lines do,
// L217/267) — a zero-text reasoning part DOES emit and labels "<1k" ("0k" never).
// Envelope extension = contentChars as the SIXTH (last) key on reasoning rows only;
// the strict five-key census stays EXACT for every other row (named contract change).
describe("ad22 join — reasoning envelopes carry contentChars = EXACT char count from the DB text", () => {
  test("every reasoning row: contentChars equals the DB text length; no other row carries the field", () => {
    const f = timelineFixture()
    try {
      // require() keeps this test-local DB read off the module's import surface; untyped on
      // purpose — the shapes are asserted below via the envelope comparison itself.
      const { Database } = require("bun:sqlite") as { Database: any }
      const db = new Database(f.dbPath, { readonly: true })
      const rows = db
        .query(`SELECT p.id AS id, json_extract(p.data,'$.text') AS t FROM part p JOIN message m ON m.id=p.message_id WHERE p.session_id IN (?) AND json_extract(p.data,'$.type')='reasoning'`)
        .all(VIEW) as Array<{ id: string; t: string | null }>
      const truth = new Map<string, number>(rows.map((r: { id: string; t: string | null }) => [r.id, (r.t ?? "").length]))
      db.close()
      expect(truth.size).toBeGreaterThan(0) // fixture really has reasoning rows
      const envs = run(f)
      const reasoning = envs.filter((e) => e.category === "reasoning")
      expect(reasoning.length).toBe(truth.size)
      for (const e of reasoning) {
        expect(e.sourceRef.kind).toBe("dbId")
        const id = (e.sourceRef as { dbId: string }).dbId
        expect((e as any).contentChars).toBe(truth.get(id))
      }
      for (const e of envs.filter((x) => x.category !== "reasoning")) {
        expect("contentChars" in (e as any)).toBe(false) // field is scoped to the reasoning lane, strictly
      }
    } finally { f.cleanup() }
  })
  test("key order: base five keys in order; contentChars appended LAST on reasoning only", () => {
    const f = timelineFixture()
    try {
      const envs = run(f)
      const base = ["category", "ts", "sourceRef", "summary", "payloadRef"]
      for (const e of envs) {
        const keys = Object.keys(e)
        // AD27 named exception (documented, same last-key pattern): lifecycle rows append
        // partType LAST. This fixture DB has no lifecycle-part rows → branch inert here;
        // the ad27 join lane pins the real order against partEnvelope directly.
        if (e.category === "reasoning") expect(keys).toEqual([...base, "contentChars"])
        else if (e.category === "lifecycle") expect(keys).toEqual([...base, "partType"])
        else expect(keys).toEqual(base)
      }
    } finally { f.cleanup() }
  })
})

// ---------------------------------------------------------------------------
// AD27 — lifecycle event-type field (owner: cells must SHOW the type). Declared
// data path (AD22 precedent): partEnvelope already parses part.type and routes it
// but does not carry it; here it emits the OPTIONAL field partType with the
// verbatim type string for the THREE visible lifecycle kinds ONLY (patch,
// compaction, file). Every other row keeps a byte-identical five-key envelope.
// Same function serves NDJSON + live push (§6.6) — the JSON round-trip lane
// below is the by-construction proof, not an endpoint copy. step-* rows are
// excluded upstream at the join (AD18) and even a direct call stays field-free.
describe("ad27 join — lifecycle envelopes carry partType (verbatim) for patch/compaction/file ONLY", () => {
  const cfg = defaultInspectorConfig({ agentsRoot: "/tmp/ad27-a", logsDir: "/tmp/ad27-l" })
  const router = buildCategoryRouter(cfg)
  const envOf = (type: string, id = "prt_ad27") =>
    partEnvelope(
      { id, session_id: VIEW, time_created: Date.parse("2026-11-05T00:00:00.000Z"), data: JSON.stringify({ type, foo: "bar" }), rowid: 1, msg_data: null },
      router,
      new Set<string>(),
      4096,
    ) as any
  test("the three visible kinds: verbatim type string, no beautification", () => {
    for (const kind of ["patch", "compaction", "file"]) {
      const e = envOf(kind)
      expect(e.category).toBe("lifecycle") // routed per config default — the lane gate
      expect(e.partType).toBe(kind) // the EXACT string ("patch" stays "patch")
    }
  })
  test("scope-tight: every other row kind keeps a byte-identical five-key envelope", () => {
    for (const [type, role] of [["text", "user"], ["text", "assistant"], ["reasoning", "assistant"], ["tool", "assistant"], ["step-start", null], ["step-finish", null], ["patch-not-a-kind", null]] as Array<[string, string | null]>) {
      const e = partEnvelope(
        { id: "prt_ad27x" + type, session_id: VIEW, time_created: Date.parse("2026-11-05T00:00:00.000Z"), data: JSON.stringify({ type }), rowid: 2, msg_data: role === null ? null : JSON.stringify({ role }) },
        router,
        new Set<string>(),
        4096,
      ) as any
      expect("partType" in e).toBe(false)
      expect(Object.keys(e)).toEqual(["category", "ts", "sourceRef", "summary", "payloadRef"])
    }
  })
  test("key order on the positive row: base five, partType appended LAST; JSON round-trip (§6.6 one-function) carries it", () => {
    const e = envOf("compaction") as any
    expect(Object.keys(e)).toEqual(["category", "ts", "sourceRef", "summary", "payloadRef", "partType"])
    expect(JSON.parse(JSON.stringify(e)).partType).toBe("compaction")
  })
})

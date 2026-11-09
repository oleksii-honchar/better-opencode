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
    // AD36 NAMED re-anchor (value set, behavior unchanged): the card mandates this constant gain a
    // SECOND NAMED ENTRY, 'nudge-delivered' (delivery receipts — Phase-0: pure tracking, no content).
    // 'step-start'/'step-finish' semantics are byte-identical; the pin's INTENT (named, commented,
    // single toggle) is asserted below and stays untouched.
    // v14 (Design v1 traceability, design 261107): the AD36(B) nudge-delivered entry is
    // SUPPRESSED into the lane system (labeled receipts, never invisibility) — only the
    // join-plumbing step names stay excluded.
    expect(EXCLUDED_EVENT_TYPES).toEqual(["step-start", "step-finish"])
    const src = require("node:fs").readFileSync(new URL("./timeline.ts", import.meta.url), "utf8") as string
    // Checker anchor fix (during GREEN): the owner comment PRECEDES the export, so the slice
    // window is taken from the declaration backwards incl. the comment header. Pin intent —
    // "the directive is recorded AT the constant" — unchanged.
    // AD36 checker-window note: the constant now carries TWO entry-comments (AD18 + AD36), so the
    // backward window widened 500→1200; both directives being present at the constant is now pinned.
    // v14 note: the AD36 text gained a SUPERSEDED block ABOVE the constant (the third named
    // change to cite at this site) — window widened 1200→2400 by the same recorded logic:
    // every directive that governs the constant stays pinned, including the owner supersession.
    const idx = src.indexOf("export const EXCLUDED_EVENT_TYPES")
    const decl = src.slice(Math.max(0, idx - 2400), idx + 300)
    expect(decl).toMatch(/not informative/i) // owner directive recorded at the constant, per card
    expect(decl).toMatch(/2026-11-05/)
    expect(decl).toMatch(/delivery receipt|DELIVERY RECEIPT/i) // AD36: second entry documented at the constant too
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
        // NAMED CONTRACT UPDATE (AD37): 'other' rows sourced from HISTORY lines carry a SIXTH
        // key historyEvent (the record's own event string; the ad37 join lane pins both sides).
        // This golden stream's line:other:7 IS such a row — its expected key set grows here and
        // nowhere else. Part-feed rows (incl. fall-throughs like prt_unk_part) stay STRICT five.
        expect(Object.keys(e)).toEqual(
          e.category === "reasoning" ? [...base, "contentChars"]
            : e.category === "lifecycle" ? [...base, "partType"]
            : e.category === "other" && e.sourceRef.kind === "historyLine" ? [...base, "historyEvent"]
            : base,
        )
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
        // AD37 named exception (same sanctioned last-key pattern): catch-all rows sourced from
        // HISTORY lines append historyEvent LAST (this fixture's line:other:7 exercises it —
        // the ad37 join lane pins both sides); part-feed fall-throughs stay STRICT five.
        if (e.category === "reasoning") expect(keys).toEqual([...base, "contentChars"])
        else if (e.category === "lifecycle") expect(keys).toEqual([...base, "partType"])
        else if (e.category === "other" && e.sourceRef.kind === "historyLine") expect(keys).toEqual([...base, "historyEvent"])
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


// ---------------------------------------------------------------------------
// AD36 — data-source honesty pass (Phase-0 evidence: real DB copy + view-folder
// history.jsonl). THREE root causes, THREE lanes:
//  A: the live SSE path (liveEnvelopeFor → partEnvelope) had NO exclusion guard —
//     join filters step-*, live pushed them back. The owner watched a RUNNING session:
//     that is the leak's mechanism (their session: 206/204 step parts, live view).
//  B: nudge-delivered is a history.jsonl EVENT (details = pure delivery tracking:
//     "kind=… node=…" — no nudge body, no duplication of nudge content, Phase-0
//     proof) that the router catch-alls into 'other'. Second named EXCLUDED constant.
//  C: engine-nudges fallback rows are synthetic text parts whose OWN text carries the
//     nudge type verbatim ("<system-reminder>\n  Traversal Check:", "Rule Compliance:"…)
//     — join-scoped nudgeKind field (AD27 pattern), renderer labels verbatim.
describe("ad36 join: history-arm exclusions + scoped nudgeKind (real-shaped records)", () => {
  const SB6 = "ses_ad36_view"
  function ad36Fixture() {
    const dirs = tempDirs()
    const dbPath = path.join(dirs.configDir, "engine.db")
    makeFixtureSessionDb(dbPath)
    insertSession(dbPath, { id: SB6, title: "ad36 view", timeCreated: 1000, timeUpdated: 9000 })
    insertMessage(dbPath, { id: "msg_u", sessionId: SB6, timeCreated: 1000, role: "user" })
    insertMessage(dbPath, { id: "msg_a", sessionId: SB6, timeCreated: 8000, role: "assistant" })
    // REAL-SHAPED nudge records (header token bytes verbatim from the live-store probe):
    insertPart(dbPath, { id: "prt_nl_traversal", messageId: "msg_u", sessionId: SB6, timeCreated: 2000, data: { type: "text", text: "<system-reminder>\n  Traversal Check:\n  - You have a persona decision tree. Enter it before your next tool.\n  This is a deterministic reminder - no model call was made.\nContinue with your task.\n</system-reminder>", synthetic: true } })
    insertPart(dbPath, { id: "prt_nl_rules", messageId: "msg_u", sessionId: SB6, timeCreated: 3000, data: { type: "text", synthetic: true, text: "<system-reminder><system-reminder>\n  Rule Compliance:\n  - Before other action, did you load agent-persona-base first?\n</system-reminder>" } })
    // headerless synthetic (real attachment-pointer shape): NO type string exists in the record
    insertPart(dbPath, { id: "prt_nl_bare", messageId: "msg_u", sessionId: SB6, timeCreated: 4000, data: { type: "text", synthetic: true, text: "Attached file: image-1.png — use \"opencode://attachment/036d75b1\" as the data argument for tools like extract_bytes" } })
    // negative-scope row: lifecycle keeps its OWN six-key census; NEVER carries nudgeKind
    insertPart(dbPath, { id: "prt_l6", messageId: "msg_a", sessionId: SB6, timeCreated: 8000, data: { type: "patch", snapshot: "s1" } })
    const folder = path.join(dirs.agentsDir, "ad36", SB6)
    writeSessionFolder(folder, { sessionId: SB6, noHistory: true })
    const lines = [
      // A: step-* NAMED on the history arm too (source-path honesty: whatever path it arrives by)
      JSON.stringify({ ts: "2026-11-06T10:00:01.000Z", sessionId: SB6, agent: "engine", event: "step-start", details: null, nextAgent: null, phase: null, status: null }),
      JSON.stringify({ ts: "2026-11-06T10:00:02.000Z", sessionId: SB6, agent: "engine", event: "step-finish", details: null, nextAgent: null, phase: null, status: null }),
      // B: nudge-delivered receipts, verbatim real shape — must NOT land in 'other' (or anywhere)
      JSON.stringify({ ts: "2026-11-06T10:00:03.000Z", sessionId: SB6, agent: "simple-session", event: "nudge-delivered", details: "kind=traversal-ladder node=file_c108d7053d7dbde977fb5b2e682e0784", nextAgent: null, phase: null, status: null }),
      JSON.stringify({ ts: "2026-11-06T10:00:04.000Z", sessionId: SB6, agent: "simple-session", event: "nudge-delivered", details: "kind=category-progress node=file_x", nextAgent: null, phase: null, status: null }),
      // unchanged neighbors: pipeline keeps its own vocabulary
      historyLine({ ts: "2026-11-06T10:00:05.000Z", sessionId: SB6, agent: "developer", event: "started", nextAgent: "worker", phase: "implementation", status: null }),
      // v14 (Design v1 traceability): the NEW coach names — judge-family kv lines land in
      // coach-judge; persona-boot joins transitions; neither is a catch-all leftover.
      JSON.stringify({ ts: "2026-11-06T10:00:06.000Z", sessionId: SB6, agent: "simple-session", event: "judge-assess", details: "kind=traversal answer=none node=file_a1", nextAgent: null, phase: null, status: null }),
      JSON.stringify({ ts: "2026-11-06T10:00:07.000Z", sessionId: SB6, agent: "simple-session", event: "judge-summary", details: "pos=file_a1 moves=3 path=a,b flags=turns_absorbed=9 unabsorbed=0 calls=2 digest=" + "x".repeat(500), nextAgent: null, phase: null, status: null }),
      JSON.stringify({ ts: "2026-11-06T10:00:08.000Z", sessionId: SB6, agent: "session", event: "persona-boot", details: null, nextAgent: null, phase: null, status: null }),
    ]
    writeFileSync(path.join(folder, "history.jsonl"), lines.map((l) => l + "\n").join(""))
    const base = defaultInspectorConfig({ agentsRoot: dirs.agentsDir, logsDir: dirs.logsDir })
    const config: SessionInspectorConfig = { ...base, paths: { ...base.paths, dbMode: dbPath } }
    return { dbPath, folder, cleanup: dirs.cleanup, config }
  }
  const run = (f: ReturnType<typeof ad36Fixture>): TimelineEnvelope[] => {
    const r = buildTimeline({ dbPath: f.dbPath, sessionId: SB6, sessionPath: f.folder, io: nodeScanIO(), config: f.config, filters: {} })
    if (!r.ok) throw new Error(`timeline failed: ${r.code} ${r.message}`)
    return r.envelopes
  }
  test("A: step-start/step-finish lines on the HISTORY arm never render (any category) — display-exclusion holds whatever the source path", () => {
    const f = ad36Fixture()
    try {
      const envs = run(f)
      const stepish = envs.filter((e) => /step-(start|finish)/.test(JSON.stringify(e.sourceRef ?? "") + String(e.summary)))
      expect(stepish).toEqual([])
      // the 'started' neighbor still renders in pipeline (over-blocking guard)
      const started = envs.filter((e) => e.category === "pipeline")
      expect(started.length).toBe(1)
      expect(started[0]!.summary).toContain("started")
    } finally { f.cleanup() }
  })
  test("B (v14 contract): nudge-delivered receipts render in coach-activity with receipt wording — labeled bookkeeping, never 'other', never content; other lanes unchanged", () => {
    const f = ad36Fixture()
    try {
      const envs = run(f)
      expect(envs.filter((e) => e.category === "other")).toEqual([]) // the ORIGINAL over-block guard: nothing leaks to catch-all
      const receipts = envs.filter((e) => e.category === "coach-activity")
      expect(receipts.length).toBe(2)
      // the summary states the record (kind/node tracking) — NO content bytes ride a receipt
      expect(receipts.map((e) => e.summary).sort()).toEqual([
        "received · kind=category-progress node=file_x",
        "received · kind=traversal-ladder node=file_c108d7053d7dbde977fb5b2e682e0784",
      ])
      // the content lane is untouched by the receipts (Task 4b join renders nudge content separately; test C pins it)
      for (const r of receipts) expect(JSON.stringify(r)).not.toContain("Traversal Check")
      // over-exclusion guard: the pipeline neighbor keeps rendering exactly as before
      expect(envs.filter((e) => e.category === "pipeline").length).toBe(1)
    } finally { f.cleanup() }
  })
  test("D (v14): judge-assess/judge-summary classify to coach-judge with their record text (display-bounded); persona-boot classifies to transitions (no bank flag — it is not a traversal record)", () => {
    const f = ad36Fixture()
    try {
      const envs = run(f)
      const jd = envs.filter((e) => e.category === "coach-judge")
      expect(jd.length).toBe(2)
      const settle = jd.find((e) => e.summary === "kind=traversal answer=none node=file_a1")
      expect(settle).toBeDefined()
      const summ = jd.find((e) => e.summary.startsWith("pos=file_a1 moves=3"))
      expect(summ).toBeDefined()
      expect(summ!.summary.length).toBe(141) // 140-char display bound + ellipsis — the raw 500-x never reaches the UI
      expect(summ!.summary.endsWith("…")).toBe(true)
      const boot = envs.filter((e) => e.category === "transitions")
      expect(boot.length).toBe(1)
      expect(boot[0]!.summary).toBe("persona-boot")
      expect((boot[0] as any).sourceRef.bankAuthoritative).toBeUndefined()
      expect(envs.filter((e) => e.category === "other")).toEqual([])
    } finally { f.cleanup() }
  })
  test("C: nudge rows carry nudgeKind = the record's OWN header token verbatim-lowercased (join-scoped, LAST key); headerless synthetics stay strict five keys; lifecycle rows byte-unchanged (no nudgeKind ever)", () => {
    const f = ad36Fixture()
    try {
      const envs = run(f)
      const byId = (id: string) => envs.find((e) => e.sourceRef.kind === "dbId" && e.sourceRef.dbId === id) as any
      const t = byId("prt_nl_traversal")
      expect(t).toBeDefined()
      expect(t.category).toBe("engine-nudges")
      expect(t.nudgeKind).toBe("traversal check")
      expect(Object.keys(t)).toEqual(["category", "ts", "sourceRef", "summary", "payloadRef", "nudgeKind"]) // LAST key (AD27 census order)
      const rc = byId("prt_nl_rules")
      expect(rc.nudgeKind).toBe("rule compliance")
      const bare = byId("prt_nl_bare")
      expect(bare.nudgeKind).toBeUndefined()
      expect(Object.keys(bare)).toEqual(["category", "ts", "sourceRef", "summary", "payloadRef"]) // strict five KEPT for no-header records
      const lc = byId("prt_l6")
      expect(lc.nudgeKind).toBeUndefined() // scope: lifecycle rows NEVER carry the nudge field
      expect(Object.keys(lc)).toEqual(["category", "ts", "sourceRef", "summary", "payloadRef", "partType"]) // AD27 census unchanged
    } finally { f.cleanup() }
  })
})


// ---------------------------------------------------------------------------
// AD37 — 'Other' cells carry the record's OWN event string (owner: "for cells in
// 'Other' write content.event to cell"). The join already parses line.event at the
// history arm; this is the ESTABLISHED scoped-optional-field pattern (AD27 partType,
// AD36 nudgeKind), new lane, value-anchored name: historyEvent (NOT category-anchored).
// Scope is tight by CONSTRUCTION: the value exists only for history-arm records —
// part feeds (both arms) and the live removed-marker have no event string → NO field.
describe("ad37 join: catch-all 'other' rows carry their own history event string (verbatim, scoped)", () => {
  const SB7 = "ses_ad37_view"
  function ad37Fixture() {
    const dirs = tempDirs()
    const dbPath = path.join(dirs.configDir, "engine.db")
    makeFixtureSessionDb(dbPath)
    insertSession(dbPath, { id: SB7, title: "ad37 view", timeCreated: 1000, timeUpdated: 9000 })
    insertMessage(dbPath, { id: "msg_u", sessionId: SB7, timeCreated: 1000, role: "user" })
    insertMessage(dbPath, { id: "msg_a", sessionId: SB7, timeCreated: 8000, role: "assistant" })
    // negatives across EVERY other row kind (a scoped field must not leak into any of them)
    insertPart(dbPath, { id: "prt_txt7", messageId: "msg_a", sessionId: SB7, timeCreated: 8000, data: { type: "text", text: "ordinary assistant text" } })
    insertPart(dbPath, { id: "prt_lifecycle7", messageId: "msg_a", sessionId: SB7, timeCreated: 8001, data: { type: "patch", snapshot: "s7" } }) // its own sixth key partType; NEVER historyEvent
    insertPart(dbPath, { id: "prt_reason7", messageId: "msg_a", sessionId: SB7, timeCreated: 8002, data: { type: "reasoning", text: "r".repeat(12) } }) // sixth key contentChars; NEVER historyEvent
    insertPart(dbPath, { id: "prt_nudge7", messageId: "msg_u", sessionId: SB7, timeCreated: 2000, data: { type: "text", synthetic: true, text: "<system-reminder>\n  Traversal Check:\n  - persona tree first.\n</system-reminder>" } }) // sixth key nudgeKind; NEVER historyEvent
    // THE part-feed fall-through: data.type is NOT A STRING -> no identifier -> bare brick (never stringify 42)
    insertPart(dbPath, { id: "prt_weird7", messageId: "msg_a", sessionId: SB7, timeCreated: 8003, data: { type: 42 } })
    const folder = path.join(dirs.agentsDir, "ad37", SB7)
    writeSessionFolder(folder, { sessionId: SB7, noHistory: true })
    const lines = [
      // ROUTED neighbor (must keep its strict five keys)
      historyLine({ ts: "2026-11-07T10:00:00.000Z", sessionId: SB7, agent: "developer", event: "started", nextAgent: "worker", phase: "implementation", status: null }),
      // fall-through: a DELIBERATELY WEIRD identifier — underscores/uppercase survive untouched (VERBATIM proof)
      JSON.stringify({ ts: "2026-11-07T10:00:01.000Z", sessionId: SB7, agent: "who-knows", event: "zzz.WEIRD__Event-7", details: "keep me raw", nextAgent: null, phase: null, status: null }),
      // second fall-through: plain name
      JSON.stringify({ ts: "2026-11-07T10:00:02.000Z", sessionId: SB7, agent: "who-knows", event: "some.future_event", details: null, nextAgent: null, phase: null, status: null }),
    ]
    writeFileSync(path.join(folder, "history.jsonl"), lines.map((l) => l + "\n").join(""))
    const base = defaultInspectorConfig({ agentsRoot: dirs.agentsDir, logsDir: dirs.logsDir })
    const config: SessionInspectorConfig = { ...base, paths: { ...base.paths, dbMode: dbPath } }
    return { dbPath, folder, cleanup: dirs.cleanup, config }
  }
  const run = (f: ReturnType<typeof ad37Fixture>): TimelineEnvelope[] => {
    const r = buildTimeline({ dbPath: f.dbPath, sessionId: SB7, sessionPath: f.folder, io: nodeScanIO(), config: f.config, filters: {} })
    if (!r.ok) throw new Error(`timeline failed: ${r.code} ${r.message}`)
    return r.envelopes
  }
  test("fall-through history rows carry historyEvent == the record's own event string, VERBATIM (weird stays weird), LAST key after the base five", () => {
    const f = ad37Fixture()
    try {
      const envs = run(f)
      const base = ["category", "ts", "sourceRef", "summary", "payloadRef"]
      const byRef = (ln: number) => envs.find((e) => e.sourceRef.kind === "historyLine" && e.sourceRef.line === ln) as any
      const weird = byRef(2)
      expect(weird.category).toBe("other") // established catchAll routing unchanged
      expect(weird.historyEvent).toBe("zzz.WEIRD__Event-7") // exact bytes — NO beautification ANYWHERE in the join
      expect(Object.keys(weird)).toEqual([...base, "historyEvent"]) // LAST key — named sixth-key census pattern
      const plain = byRef(3)
      expect(plain.historyEvent).toBe("some.future_event")
    } finally { f.cleanup() }
  })
  test("scope-tight negatives: routed history rows, ALL part-feed kinds (incl. the data.type=42 part that falls through to other!) and every non-field row are BYTE-IDENTICAL five-key — parts have NO event string (bare brick, never stringified garbage)", () => {
    const f = ad37Fixture()
    try {
      const envs = run(f)
      const base = ["category", "ts", "sourceRef", "summary", "payloadRef"]
      const byId = (id: string) => envs.find((e) => e.sourceRef.kind === "dbId" && e.sourceRef.dbId === id) as any
      const started = envs.find((e) => e.category === "pipeline") as any
      expect(Object.keys(started)).toEqual(base)
      const txt = byId("prt_txt7")
      expect(Object.keys(txt)).toEqual(base) // assistant-text: strict five, no leaked field
      const lc = byId("prt_lifecycle7")
      expect(Object.keys(lc)).toEqual([...base, "partType"]) // its OWN sixth key; no historyEvent ever
      expect(lc.historyEvent).toBeUndefined()
      const rz = byId("prt_reason7")
      expect(Object.keys(rz)).toEqual([...base, "contentChars"])
      expect(rz.historyEvent).toBeUndefined()
      const nd = byId("prt_nudge7")
      expect(Object.keys(nd)).toEqual([...base, "nudgeKind"])
      expect(nd.historyEvent).toBeUndefined()
      const partOther = byId("prt_weird7") // part feed that DOES fall through to other: no history identity exists for it
      expect(partOther.category).toBe("other")
      expect(partOther.historyEvent).toBeUndefined() // 42 is NEVER stringified into a label
      expect(Object.keys(partOther)).toEqual(base) // bare brick
    } finally { f.cleanup() }
  })
})


// ---------------------------------------------------------------------------
// AD38 (R3) — the end-to-end consequence, proven at the JOIN with zero join code:
// a gate-blocked history line reroutes to coach-activity AND thereby falls out of
// the AD37 catch-all scope (no historyEvent on a ROUTED row — scope is by category
// at construction, so this is auto-proved, not new code). The rows that DO stay in
// other keep carrying their field; every other kind is byte-identical.
describe("ad38 join: gate-blocked reroutes to coach-activity and auto-drops the AD37 field", () => {
  const SB8 = "ses_ad38_view"
  function ad38Fixture() {
    const dirs = tempDirs()
    const dbPath = path.join(dirs.configDir, "engine.db")
    makeFixtureSessionDb(dbPath)
    insertSession(dbPath, { id: SB8, title: "ad38 view", timeCreated: 1000, timeUpdated: 9000 })
    insertMessage(dbPath, { id: "msg_a", sessionId: SB8, timeCreated: 8000, role: "assistant" })
    insertPart(dbPath, { id: "prt_txt8", messageId: "msg_a", sessionId: SB8, timeCreated: 8000, data: { type: "text", text: "ordinary assistant text" } })
    const folder = path.join(dirs.agentsDir, "ad38", SB8)
    writeSessionFolder(folder, { sessionId: SB8, noHistory: true })
    const lines = [
      JSON.stringify({ ts: "2026-11-07T10:00:00.000Z", sessionId: SB8, agent: "meta-tool", event: "gate-blocked", details: "TREE_NOT_ENTERED", nextAgent: null, phase: null, status: null }),
      JSON.stringify({ ts: "2026-11-07T10:00:01.000Z", sessionId: SB8, agent: "coach", event: "agent.coach", details: null, nextAgent: null, phase: null, status: null }),
      JSON.stringify({ ts: "2026-11-07T10:00:02.000Z", sessionId: SB8, agent: "who-knows", event: "some.future_event", details: null, nextAgent: null, phase: null, status: null }),
    ]
    writeFileSync(path.join(folder, "history.jsonl"), lines.map((l) => l + "\n").join(""))
    const base = defaultInspectorConfig({ agentsRoot: dirs.agentsDir, logsDir: dirs.logsDir })
    const config: SessionInspectorConfig = { ...base, paths: { ...base.paths, dbMode: dbPath } }
    return { dbPath, folder, cleanup: dirs.cleanup, config }
  }
  test("gate-blocked row: category coach-activity, historyEvent ABSENT (routed rows are out of scope), strict five keys; the untouched future-event row STILL carries its field; neighbors byte-identical", () => {
    const f = ad38Fixture()
    try {
      const r = buildTimeline({ dbPath: f.dbPath, sessionId: SB8, sessionPath: f.folder, io: nodeScanIO(), config: f.config, filters: {} })
      if (!r.ok) throw new Error(`timeline failed: ${r.code} ${r.message}`)
      const envs = r.envelopes
      const base = ["category", "ts", "sourceRef", "summary", "payloadRef"]
      const byLine = (ln: number) => envs.find((e) => e.sourceRef.kind === "historyLine" && e.sourceRef.line === ln) as any
      const gb = byLine(1)
      expect(gb.category).toBe("coach-activity")
      expect(gb.historyEvent).toBeUndefined()
      expect(Object.keys(gb)).toEqual(base)
      const coach = byLine(2)
      expect(coach.category).toBe("coach-activity")
      expect(Object.keys(coach)).toEqual(base) // byte-identical to how coach rows always rendered
      const surviving = byLine(3)
      expect(surviving.category).toBe("other")
      expect(surviving.historyEvent).toBe("some.future_event") // AD37 label path INTACT for what truly remains
      expect(Object.keys(surviving)).toEqual([...base, "historyEvent"])
      const txt = envs.find((e) => e.sourceRef.kind === "dbId" && (e.sourceRef as any).dbId === "prt_txt8") as any
      expect(Object.keys(txt)).toEqual(base)
    } finally { f.cleanup() }
  })
})

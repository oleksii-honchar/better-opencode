import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdirSync, writeFileSync } from "node:fs"
import { parsePayloadRef, resolvePayload, TOOLS_LOG_ROTATIONS } from "./payload"
import { defaultInspectorConfig } from "./config.schema"
import type { SessionInspectorConfig } from "./config.schema"
import {
  insertMessage,
  insertPart,
  insertSession,
  judgeRecordV11,
  historyLine,
  makeFixtureSessionDb,
  nodeScanIO,
  tempDirs,
  writeJudgeRecords,
  writeToolsLogFiles,
} from "./session-inspector.test-utils"

// Task 4 AC4/AC5/AC7 — the payload endpoint's pointer resolution: all three payloadRef kinds
// (dbId, historyLine incl. judge-file lines, logLine-by-callId) round-trip from fixtures;
// caps come ONLY from config and never truncate silently ({truncated, fullLength} present
// explicitly on every resolution); a missing legacy judge file yields an explicit source-absent
// marker, never a silent hole; tools.log rotations are searched newest-back and absence
// degrades ONLY the enrichment while the response states the file was absent.

const T0 = "2026-11-03T09:00:00.000Z"

const SESSION = "ses_t4_payload"

function fixture(options: { judge?: boolean; tools?: boolean; capBytes?: number } = {}) {
  const dirs = tempDirs()
  const dbPath = path.join(dirs.configDir, "engine.db")
  makeFixtureSessionDb(dbPath)
  insertSession(dbPath, { id: SESSION, title: "payload fixture", timeCreated: Date.parse(T0), timeUpdated: Date.parse(T0) })
  insertMessage(dbPath, { id: "msg_p", sessionId: SESSION, timeCreated: Date.parse(T0), role: "assistant" })
  const partData = { type: "text", text: "x".repeat(500) }
  insertPart(dbPath, { id: "prt_big", messageId: "msg_p", sessionId: SESSION, timeCreated: Date.parse(T0), data: partData })

  const folder = path.join(dirs.agentsDir, "fixture", SESSION)
  mkdirSync(path.join(folder, "materials"), { recursive: true })
  writeFileSync(path.join(folder, "session.md"), `---\nsessionId: ${SESSION}\n---\n\n# fixture\n`)
  const hist = [
    historyLine({ ts: T0, sessionId: SESSION, agent: "employee", event: "started" }),
    historyLine({ ts: "2026-11-03T09:00:01.000Z", sessionId: SESSION, agent: "coach", event: "agent.coach", details: JSON.stringify({ category: "boot", action: "skip", reason_code: "no_match" }) }),
  ]
  writeFileSync(path.join(folder, "history.jsonl"), hist.map((l) => l + "\n").join(""))
  if (options.judge) {
    writeJudgeRecords(folder, [
      judgeRecordV11({ v: 11, sid: SESSION, seq: 7, ts: T0, kind: "traversal", node: "20-tdd", backend: "litellm:judge", model: null, request: { p: 1 }, answer: { a: 2 } }),
    ])
  }
  if (options.tools) {
    writeToolsLogFiles(dirs.logsDir, {
      "tools.log": ['{"ts":"t","msg":"current file decoy"}', '{"callID":"call_new","durMs":12,"truncated":false}'],
      "tools-1": ['{"callID":"call_old","durMs":99,"truncated":true}'],
      "tools-2": ['{"callID":"call_mid","durMs":7,"truncated":false}'],
    })
  }
  const config = defaultInspectorConfig({ agentsRoot: dirs.agentsDir, logsDir: dirs.logsDir })
  const cfg: SessionInspectorConfig = {
    ...config,
    paths: { ...config.paths, dbMode: dbPath },
    limits: { ...config.limits, payloadCapBytes: options.capBytes ?? 8192 },
  }
  return { dirs, dbPath, folder, cleanup: dirs.cleanup, config: cfg, partData }
}

const io = nodeScanIO()

describe("payload resolution — all three payloadRef kinds (AC5)", () => {
  test("dbId kind round-trips the part's data JSON", () => {
    const f = fixture()
    try {
      const result = resolvePayload({
        dbPath: f.dbPath,
        sessionId: SESSION,
        sessionPath: f.folder,
        io,
        config: f.config,
        ref: { kind: "dbId", dbId: "prt_big" },
      })
      expect(result.payload).toEqual(f.partData)
      expect(result.truncated).toBe(false)
      // fullLength is ALWAYS present and equals the stored data bytes
      expect(result.fullLength).toBe(Buffer.byteLength(JSON.stringify(f.partData), "utf8"))
      expect(result.sourceAbsent).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })

  test("historyLine kind round-trips the exact line, 1-based, with key order preserved", () => {
    const f = fixture()
    try {
      const result = resolvePayload({
        dbPath: f.dbPath,
        sessionId: SESSION,
        sessionPath: f.folder,
        io,
        config: f.config,
        ref: { kind: "historyLine", file: "history.jsonl", line: 2 },
      })
      expect((result.payload as { event?: string }).event).toBe("agent.coach")
      // builder key order preserved through the parse path
      expect(Object.keys(result.payload as object)).toEqual(["ts", "sessionId", "agent", "event", "details", "nextAgent", "phase", "status"])
      const outOfRange = resolvePayload({ dbPath: f.dbPath, sessionId: SESSION, sessionPath: f.folder, io, config: f.config, ref: { kind: "historyLine", file: "history.jsonl", line: 99 } })
      expect(outOfRange.sourceAbsent).toBeTruthy()
    } finally {
      f.cleanup()
    }
  })

  test("logLine kind resolves by callId across rotated tools.log files, newest-back", () => {
    const f = fixture({ tools: true })
    try {
      const current = resolvePayload({ dbPath: f.dbPath, sessionId: SESSION, sessionPath: f.folder, io, config: f.config, ref: { kind: "logLine", callId: "call_new" } })
      expect(current.payload).toContain("call_new")
      const inRotation = resolvePayload({ dbPath: f.dbPath, sessionId: SESSION, sessionPath: f.folder, io, config: f.config, ref: { kind: "logLine", callId: "call_old" } })
      expect((inRotation.payload as string)).toContain("call_old")
      expect((inRotation.payload as string)).toContain("durMs")
      expect(inRotation.source).toMatchObject({ file: "tools-1" })
      const missing = resolvePayload({ dbPath: f.dbPath, sessionId: SESSION, sessionPath: f.folder, io, config: f.config, ref: { kind: "logLine", callId: "call_never" } })
      expect(missing.sourceAbsent).toBeTruthy()
    } finally {
      f.cleanup()
    }
  })

  test("rotation search list is exactly tools.log + tools-1..5 (newest-back, bounded)", () => {
    expect(TOOLS_LOG_ROTATIONS).toEqual(["tools.log", "tools-1", "tools-2", "tools-3", "tools-4", "tools-5"])
  })
})

describe("payload truncation — explicit, config-capped, never silent (AC5)", () => {
  test("payload over config cap → {truncated:true, fullLength} present and payload slice bounded by the cap", () => {
    const f = fixture({ capBytes: 64 })
    try {
      const result = resolvePayload({ dbPath: f.dbPath, sessionId: SESSION, sessionPath: f.folder, io, config: f.config, ref: { kind: "dbId", dbId: "prt_big" } })
      expect(result.truncated).toBe(true)
      const full = JSON.stringify(f.partData)
      expect(result.fullLength).toBe(Buffer.byteLength(full, "utf8"))
      const sliced = result.payload as string
      expect(typeof sliced).toBe("string")
      expect(Buffer.byteLength(sliced, "utf8")).toBeLessThanOrEqual(64)
      expect(full.startsWith(sliced)).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  test("truncation flag on a history line uses the same contract", () => {
    const f = fixture({ capBytes: 40 })
    try {
      const result = resolvePayload({ dbPath: f.dbPath, sessionId: SESSION, sessionPath: f.folder, io, config: f.config, ref: { kind: "historyLine", file: "history.jsonl", line: 1 } })
      expect(result.truncated).toBe(true)
      const fullBytes = Buffer.byteLength(readLine(f.folder, 1), "utf8")
      expect(result.fullLength).toBe(fullBytes)
    } finally {
      f.cleanup()
    }
  })
})



describe("legacy judge records — auto-detect, ordered parse, explicit absence (AC4)", () => {
  test("judge file line resolves under the judge payload path with v11 field order PRESERVED through the parse", () => {
    const f = fixture({ judge: true })
    try {
      const result = resolvePayload({
        dbPath: f.dbPath,
        sessionId: SESSION,
        sessionPath: f.folder,
        io,
        config: f.config,
        ref: { kind: "historyLine", file: "materials/judge-records.jsonl", line: 1 },
      })
      expect(result.payload).toBeTruthy()
      // ADR-0011 §3 fixed order: v,sid,seq,ts,kind,node,backend,model,request,answer (+ conditional error)
      expect(Object.keys(result.payload as object)).toEqual(["v", "sid", "seq", "ts", "kind", "node", "backend", "model", "request", "answer"])
    } finally {
      f.cleanup()
    }
  })

  test("session WITHOUT judge-records.jsonl → explicit source-absent marker (never a silent null)", () => {
    const f = fixture({ judge: false })
    try {
      const result = resolvePayload({
        dbPath: f.dbPath,
        sessionId: SESSION,
        sessionPath: f.folder,
        io,
        config: f.config,
        ref: { kind: "historyLine", file: "materials/judge-records.jsonl", line: 1 },
      })
      expect(result.sourceAbsent).toBeTruthy()
      expect(JSON.stringify(result)).toContain("judge-records.jsonl")
      expect(result.payload ?? null).toBe(null)
    } finally {
      f.cleanup()
    }
  })
})

describe("tools.log absence — enrichment degrades only and the response SAYS so (AC7)", () => {
  test("no tools.log files at all → explicit file-absent statement, resolution otherwise intact", () => {
    const f = fixture({ tools: false })
    try {
      const missing = resolvePayload({ dbPath: f.dbPath, sessionId: SESSION, sessionPath: f.folder, io, config: f.config, ref: { kind: "logLine", callId: "call_new" } })
      expect(missing.sourceAbsent).toBeTruthy()
      expect(JSON.stringify(missing)).toContain("tools.log")
      // the same request path still resolves non-log refs:
      const db = resolvePayload({ dbPath: f.dbPath, sessionId: SESSION, sessionPath: f.folder, io, config: f.config, ref: { kind: "dbId", dbId: "prt_big" } })
      expect(db.resolved).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  test("toolsLogEnrichment=false → logLine explicitly reports the source-disabled reason, files untouched on disk", () => {
    const f = fixture({ tools: true })
    try {
      const disabledCfg: SessionInspectorConfig = { ...f.config, limits: { ...f.config.limits, toolsLogEnrichment: false } }
      const result = resolvePayload({ dbPath: f.dbPath, sessionId: SESSION, sessionPath: f.folder, io, config: disabledCfg, ref: { kind: "logLine", callId: "call_new" } })
      expect(result.sourceAbsent).toBeTruthy()
      expect(JSON.stringify(result)).toContain("disabled")
    } finally {
      f.cleanup()
    }
  })
})

describe("payload ref parsing (input validation)", () => {
  test("ref query parsing is strict: unknown kind / bad line / missing callId are reported", () => {
    expect(parsePayloadRef(new URLSearchParams({ kind: "dbId", dbId: "x" })).ok).toBe(true)
    expect(parsePayloadRef(new URLSearchParams({ kind: "historyLine", line: "3" })).ok).toBe(true)
    expect(parsePayloadRef(new URLSearchParams({ kind: "historyLine", line: "0" })).ok).toBe(false)
    expect(parsePayloadRef(new URLSearchParams({ kind: "logLine", callId: "c" })).ok).toBe(true)
    expect(parsePayloadRef(new URLSearchParams({ kind: "logLine" })).ok).toBe(false)
    expect(parsePayloadRef(new URLSearchParams({ kind: "nope" })).ok).toBe(false)
    // file parameter restricted to the two fixed contract paths — no traversal
    expect(parsePayloadRef(new URLSearchParams({ kind: "historyLine", line: "1", file: "history.jsonl" })).ok).toBe(true)
    expect(parsePayloadRef(new URLSearchParams({ kind: "historyLine", line: "1", file: "materials/judge-records.jsonl" })).ok).toBe(true)
    expect(parsePayloadRef(new URLSearchParams({ kind: "historyLine", line: "1", file: "../../etc/passwd" })).ok).toBe(false)
  })
})

function readLine(folder: string, line: number): string {
  const text = io.read(path.join(folder, "history.jsonl")) ?? ""
  // fixture-local reader: fullLength convention = raw bytes of the JSON line WITHOUT the newline
  return text.split("\n")[line - 1]
}

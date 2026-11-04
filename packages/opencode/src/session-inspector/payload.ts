import path from "node:path"
import { openInspectorDb } from "./db"
import type { ScanIO } from "./session-scan"
import type { SessionInspectorConfig } from "./config.schema"

// GET /session-inspector/session/:id/payload — pointer-resolution (spec §5.1-2, §6.6: object
// endpoint stays JSON). Caps come ONLY from config.limits (never from call sites); truncation
// is never silent: {truncated, fullLength} are ALWAYS present on a resolved payload; source
// absence (missing legacy judge file, missing tools.log, out-of-range line, unresolved folder,
// disabled enrichment) is an EXPLICIT source-absent marker — the drawer must be able to say
// "the file was absent" instead of rendering a silent hole (spec §6.4).

/** The two per-session JSONL sources an endpoint may address — a fixed contract whitelist
 * (never an open path parameter: no traversal). */
export type TimelineFile = "history.jsonl" | "materials/judge-records.jsonl"

/** tools.log rotation search order: CURRENT file first, then tools-1..5 — newest-back,
 * bounded at the engine's own rotation cap (measured core/util/log.ts: shift keeps 5, 2026-11-03). */
export const TOOLS_LOG_ROTATIONS = ["tools.log", "tools-1", "tools-2", "tools-3", "tools-4", "tools-5"] as const

export type PayloadRef =
  | { kind: "dbId"; dbId: string }
  | { kind: "historyLine"; file: TimelineFile; line: number }
  | { kind: "logLine"; callId: string }

export function parsePayloadRef(params: URLSearchParams): { ok: true; ref: PayloadRef } | { ok: false; message: string } {
  const kind = params.get("kind")
  if (kind === "dbId") {
    const dbId = params.get("dbId") ?? ""
    if (dbId.length === 0) return { ok: false, message: "dbId: required for kind=dbId" }
    return { ok: true, ref: { kind: "dbId", dbId } }
  }
  if (kind === "historyLine") {
    const fileParam = params.get("file") ?? "history.jsonl"
    if (fileParam !== "history.jsonl" && fileParam !== "materials/judge-records.jsonl") {
      return { ok: false, message: `file: must be "history.jsonl" or "materials/judge-records.jsonl" (got "${fileParam}")` }
    }
    const lineRaw = params.get("line") ?? ""
    const line = Number(lineRaw)
    if (!/^\d+$/.test(lineRaw) || !Number.isSafeInteger(line) || line < 1) {
      return { ok: false, message: `line: 1-based positive integer required (got "${lineRaw}")` }
    }
    return { ok: true, ref: { kind: "historyLine", file: fileParam, line } }
  }
  if (kind === "logLine") {
    const callId = params.get("callId") ?? ""
    if (callId.length === 0) return { ok: false, message: "callId: required for kind=logLine" }
    return { ok: true, ref: { kind: "logLine", callId } }
  }
  return { ok: false, message: `kind: must be one of dbId|historyLine|logLine (got "${kind ?? ""}")` }
}

export interface SourceAbsent {
  reason: string
  file?: string
  [key: string]: string | number | boolean | undefined
}

export interface PayloadResult {
  resolved: boolean
  kind: PayloadRef["kind"]
  source: Record<string, string | number>
  payload: unknown
  truncated: boolean
  fullLength: number | null
  sourceAbsent?: SourceAbsent
}

export interface ResolvePayloadInput {
  dbPath: string
  sessionId: string
  /** Resolved session folder, or undefined when the view could not be resolved — file kinds
   * then report an explicit marker instead of guessing. */
  sessionPath: string | undefined
  io: ScanIO
  config: SessionInspectorConfig
  ref: PayloadRef
}

function absent(reason: string, extra: Record<string, string | number> = {}): Pick<PayloadResult, "resolved" | "payload" | "truncated" | "fullLength" | "sourceAbsent"> {
  return { resolved: false, payload: null, truncated: false, fullLength: null, sourceAbsent: { reason, ...extra } }
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8")

function cappedText(raw: string, capBytes: number): Pick<PayloadResult, "payload" | "truncated" | "fullLength"> {
  const fullLength = byteLength(raw)
  if (fullLength <= capBytes) return { payload: raw, truncated: false, fullLength }
  const slice = Buffer.from(raw, "utf8").subarray(0, capBytes).toString("utf8")
  return { payload: slice, truncated: true, fullLength }
}

function parseOrRaw(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function resolvePayload(input: ResolvePayloadInput): PayloadResult {
  const capBytes = input.config.limits.payloadCapBytes

  if (input.ref.kind === "dbId") {
    let raw: string | undefined
    let db
    try {
      db = openInspectorDb(input.dbPath)
      const row = db.query<{ data: string }, [string]>("SELECT data FROM part WHERE id = ?").get(input.ref.dbId)
      raw = row?.data
    } catch (error) {
      return {
        kind: "dbId",
        source: { kind: "dbId", dbId: input.ref.dbId },
        resolved: false,
        payload: null,
        truncated: false,
        fullLength: null,
        sourceAbsent: { reason: "db-unreadable", message: error instanceof Error ? error.message : String(error) },
      }
    } finally {
      db?.close()
    }
    if (raw === undefined) {
      return { kind: "dbId", source: { kind: "dbId", dbId: input.ref.dbId }, ...absent("row-not-found", { dbId: input.ref.dbId }) }
    }
    const capped = cappedText(raw, capBytes)
    return {
      kind: "dbId",
      source: { kind: "dbId", dbId: input.ref.dbId },
      resolved: true,
      truncated: capped.truncated,
      fullLength: capped.fullLength,
      payload: capped.truncated ? capped.payload : parseOrRaw(raw),
    }
  }

  if (input.ref.kind === "historyLine") {
    const sourceBase: Record<string, string | number> = { kind: "historyLine", file: input.ref.file, line: input.ref.line }
    if (input.sessionPath === undefined) {
      return { kind: "historyLine", source: sourceBase, ...absent("session-folder-unresolved", { file: input.ref.file }) }
    }
    const text = input.io.read(path.join(input.sessionPath, input.ref.file))
    if (text === undefined) {
      return { kind: "historyLine", source: sourceBase, ...absent("file-absent", { file: input.ref.file }) }
    }
    const lines = text.split("\n")
    const line = lines[input.ref.line - 1]
    if (line === undefined || line.length === 0) {
      return { kind: "historyLine", source: sourceBase, ...absent("line-out-of-range", { file: input.ref.file, line: input.ref.line, available: physicalLineCount(text) }) }
    }
    const capped = cappedText(line, capBytes)
    return {
      kind: "historyLine",
      source: sourceBase,
      resolved: true,
      truncated: capped.truncated,
      fullLength: capped.fullLength,
      // JSON.parse preserves the record's insertion order — field-order governance survives (DEC-L/§6.3).
      payload: capped.truncated ? capped.payload : parseOrRaw(line),
    }
  }

  // logLine by callId — tools.log enrichment. Absence degrades ONLY the enrichment.
  const sourceBase: Record<string, string | number> = { kind: "logLine", callId: input.ref.callId }
  if (!input.config.limits.toolsLogEnrichment) {
    return { kind: "logLine", source: sourceBase, ...absent("enrichment-disabled-by-config", { file: TOOLS_LOG_ROTATIONS[0] }) }
  }
  const searched: Record<string, boolean> = {}
  for (const rotation of TOOLS_LOG_ROTATIONS) {
    const text = input.io.read(path.join(input.config.paths.logsDir, rotation))
    if (text === undefined) {
      searched[rotation] = false
      continue
    }
    searched[rotation] = true
    const needleId = [
      `"callID":"${input.ref.callId}"`,
      `"callId":"${input.ref.callId}"`,
      `"call_id":"${input.ref.callId}"`,
      `"toolCallId":"${input.ref.callId}"`,
    ]
    for (const candidate of text.split("\n")) {
      if (candidate.length === 0) continue
      if (needleId.some((needle) => candidate.includes(needle))) {
        const capped = cappedText(candidate, capBytes)
        return {
          kind: "logLine",
          source: { ...sourceBase, file: rotation },
          resolved: true,
          truncated: capped.truncated,
          fullLength: capped.fullLength,
          payload: capped.payload, // rotation lines stay raw text — a debug surface shows the line
        }
      }
    }
  }
  const anyPresent = Object.values(searched).some((seen) => seen)
  return {
    kind: "logLine",
    source: sourceBase,
    ...(anyPresent
      ? absent("callId-not-found", { files: TOOLS_LOG_ROTATIONS.join(",") })
      : absent("file-absent", { file: TOOLS_LOG_ROTATIONS[0], note: "tools.log and all rotations were absent; enrichment degraded only" })),
  }
}

function physicalLineCount(text: string): number {
  const lines = text.split("\n")
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop()
  return lines.length
}

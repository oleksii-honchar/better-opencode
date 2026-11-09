import path from "node:path"
import { openInspectorDb } from "./db"
import { buildCategoryRouter } from "./category-mapper"
import type { TimelineFile } from "./payload"
import type { ScanIO } from "./session-scan"
import type { SessionInspectorConfig } from "./config.schema"

// GET /session-inspector/session/:id/timeline — the server-side multi-source temporal join
// (spec §4, §6.4, §6.6). Sources, each authoritative for its own concern (DEC-F):
//   - engine DB parts (own session + DB-lineage children via session.parent_id)
//   - <sessionPath>/history.jsonl lines (v2.3 + additive names; DEC-L stringified `details`)
//   - <sessionPath>/materials/judge-records.jsonl when PRESENT (legacy auto-detect §5.1-5)
// Ordering: ts ascending; within one ms, DB rows by rowid (insertion order) THEN history
// lines by file byte order (§6.4). Invalid (non-JSON, unparseable-ts) source lines are
// SKIPPED — the stream continues. One envelope per source row with EXACTLY the five keys
// {category, ts, sourceRef, summary, payloadRef}; per-row extras (ref_part_id, badges,
// lineage) live INSIDE sourceRef so the envelope census stays stable (recorded reconciliation).

export interface TimelineFilters {
  from?: string
  to?: string
  categories?: string[]
}

export type TimelineSourceRef =
  | ({ kind: "dbId"; dbId: string; sessionId: string; attributed?: boolean; removed?: true } & LineageFields)
  | ({
      kind: "historyLine"
      file: TimelineFile
      line: number
      sessionId: string
      bankAuthoritative?: true
      ref_part_id?: string
      attributed?: boolean
    } & LineageFields)
  // Task 6 live lane: bare engine events carry no file/db source line (added arm; the
  // envelope stays strictly 5-key like every NDJSON timeline line, §6.6).
  | ({ kind: "liveEvent"; event: string; sessionId: string; busEventId: string } & LineageFields)

interface LineageFields {
  lineage?: "db-parent" | "history-subagent"
}

export type TimelinePayloadRef =
  | ({ kind: "dbId"; dbId: string } & TruncationFields)
  | ({ kind: "historyLine"; file: TimelineFile; line: number } & TruncationFields)

interface TruncationFields {
  truncated?: true
  fullLength?: number
}

export interface TimelineEnvelope {
  category: string
  ts: string
  sourceRef: TimelineSourceRef
  summary: string
  // null only for Task 6 live-event envelopes (bare events have no payload source —
  // the drawer renders this as an explicit statement, never a silent hole).
  payloadRef: TimelinePayloadRef | null
  // AD22 (reasoning lane only — attached as the LAST key on reasoning rows, nowhere else):
  // EXACT char count of the reasoning text measured in the READ JOIN from the uncapped
  // p.data it already loads. The payload endpoint is byte-capped and FORBIDDEN as a length
  // source (silent under-report class, DEC-I). Census tests updated as NAMED changes.
  contentChars?: number
}

export type TimelineFailure = { ok: false; code: "DB_UNREADABLE" | "INVALID_FILTER"; message: string }
export type TimelineResult = { ok: true; envelopes: TimelineEnvelope[] } | TimelineFailure

export interface BuildTimelineInput {
  dbPath: string
  sessionId: string
  sessionPath: string | undefined
  io: ScanIO
  config: SessionInspectorConfig
  filters: TimelineFilters
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8")

// AD18 — owner directive (2026-11-05): step-start / step-finish are "not informative at all";
// they are dropped at the JOIN, BEFORE category routing (config-deletion was rejected: the
// unmatched-fallback would merely relocate them to Other). Global by design — the list below
// is the single toggle if the owner ever re-wants them. Read-side only: DB rows untouched.
// AD36 (B) — SECOND NAMED ENTRY, same mechanism: `nudge-delivered` lines are Engine-Nudge
// DELIVERY RECEIPTS (Phase-0 census, real copy): details carry only "kind=… node=…" —
// pure delivery-tracking, they do NOT duplicate nudge content. The nudge CONTENT renders
// via its own lane (the synthetic-part join, Task 4b) when applicable, so receiving the
// receipt anywhere else would show bookkeeping as if it were content.
// SUPERSEDED (Design v1 traceability ruling, design 261107, 2026-11-08 — owner brief item C):
// full traceability requires every RECORDED event to be VISIBLE. The original objection was
// bookkeeping-shown-as-content; the honest fix is a LABELED receipt, not invisibility: the
// line now routes through its configured lane (default: coach-activity) with explicit receipt
// wording from historySummary's kv arm (no content bytes, no content lane touched, no
// duplication by construction — receipts never carry ref_part_id; content rows never carry
// receipt text). REGISTERED DEVIATION from AD36(B) with the owner ruling that superseded it.
export const EXCLUDED_EVENT_TYPES: readonly string[] = ["step-start", "step-finish"]

// AD36 (C) — the nudge TYPE STRING lives only inside the record itself: the reminder header
// token, verbatim ("<system-reminder>\n  Traversal Check:", "Rule Compliance:", …). Boundary
// is '>' or newline with ≤4 indent — PROVEN on the real copy: zero false heads across every
// headerless synthetic row (compaction reminder, BOOTSTRAP_PACK, skill_content, attachment
// pointers); a ^-anchored variant was REJECTED by that same probe. Field-presence only:
// records without a header carry NO type and never invent one (card: "non-string → bare brick").
const NUDGE_HEADER_RE = /(?:>|\n)[ \t]{0,4}([A-Z][A-Za-z .-]{2,42}?):/
function nudgeKindFrom(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined
  // headers live at the head of the reminder block; scanning the whole body risks mid-text prose
  const m = NUDGE_HEADER_RE.exec(text.slice(0, 240))
  return m ? m[1].trim().toLowerCase() : undefined
}

function truncationFor(raw: string, capBytes: number): TruncationFields {
  if (byteLength(raw) <= capBytes) return {}
  return { truncated: true, fullLength: byteLength(raw) }
}

interface SourceRow {
  ms: number
  bucket: 0 | 1 | 2 // §6.4: ties → DB (rowid) first, then history byte order, then judge file order
  sub: number
  envelope: TimelineEnvelope
}

export interface PartRowView {
  id: string
  session_id: string
  time_created: number
  data: string
  rowid: number
  msg_data: string | null
}

// shared timeline/live envelope builder (Task 6) — buildTimeline delegates here and the
// live endpoint calls the SAME function, so pushed lines are byte-identical to NDJSON
// lines BY CONSTRUCTION (§6.6). Lineage condition: every row the callers feed is already
// scope-filtered (primary + children), so childSet.has() alone reproduces the previous
// `session_id !== primary && childSet.has()` byte-for-byte.
export function partEnvelope(
  row: PartRowView,
  router: ReturnType<typeof buildCategoryRouter>,
  childSet: ReadonlySet<string>,
  capBytes: number,
): TimelineEnvelope {
  const parsed = tryJson(row.data)
  const partType = typeof parsed?.type === "string" ? parsed.type : ""
  const role = typeof tryJson(row.msg_data ?? undefined)?.role === "string" ? (tryJson(row.msg_data ?? undefined) as { role: string }).role : null
  const category = router.partCategory(partType, role)
  // AD27 (DECLARED data path, AD22 precedent): lifecycle cells must SHOW the event kind.
  // Scope-tight optional field: the THREE visible lifecycle kinds ONLY (step-* are excluded
  // upstream — AD18), the verbatim type string, appended LAST (sixth-key pattern like
  // contentChars). Every other row keeps a byte-identical five-key envelope. One function
  // serves NDJSON + live push (§6.6), so pushed lines carry it by construction too.
  const lifecycleLabel = category === "lifecycle" && (partType === "patch" || partType === "compaction" || partType === "file")
  return {
    category,
    ts: new Date(row.time_created).toISOString(),
    sourceRef: {
      kind: "dbId",
      dbId: row.id,
      sessionId: row.session_id,
      // DB parent_id is the PRIMARY lineage source (§6.4 / DEC-L note): the scope
      // itself is derived from it, so any non-self row here is a fold by definition.
      ...(childSet.has(row.session_id) ? { lineage: "db-parent" as const } : {}),
    },
    summary: partSummary(partType, parsed),
    payloadRef: { kind: "dbId", dbId: row.id, ...truncationFor(row.data, capBytes) },
    ...(lifecycleLabel ? { partType } : {}), // LAST key — named sixth-key census updated in the same change
  }
}

export function buildTimeline(input: BuildTimelineInput): TimelineResult {
  const filterError = validateFilters(input)
  if (filterError !== undefined) return filterError

  const fromMs = input.filters.from === undefined ? -Infinity : Date.parse(input.filters.from)
  const toMs = input.filters.to === undefined ? Infinity : Date.parse(input.filters.to)
  const router = buildCategoryRouter(input.config)
  const capBytes = input.config.limits.payloadCapBytes
  const rows: SourceRow[] = []

  // §5.6 column 10 (Task 4b): the engine-nudges lane is config-owned by `plugin.nudge`
  // history lines; DB synthetic text parts join as UNATTRIBUTED fallback rows ONLY when
  // such a column exists — and each fallback is suppressed when an attributed nudge line
  // already carries its part id via details.ref_part_id (attributed wins, never duplicated).
  const nudgesColumn = input.config.categories.find(
    (category) => category.catchAll !== true && category.sources.historyEvents?.includes("plugin.nudge") === true,
  )
  const attributedRefIds = new Set<string>()
  interface SyntheticCandidate {
    ms: number
    rowid: number
    partId: string
    envelope: TimelineEnvelope
  }
  const syntheticCandidates: SyntheticCandidate[] = []

  // -- engine DB parts ---------------------------------------------------------
  let db
  const childSet = new Set<string>()
  try {
    db = openInspectorDb(input.dbPath)
    const children = db
      .query<{ id: string }, [string]>("SELECT id FROM session WHERE parent_id = ?")
      .all(input.sessionId)
      .map((row) => row.id)
    for (const child of children) childSet.add(child)
    const scoped = [input.sessionId, ...children]
    const placeholders = scoped.map(() => "?").join(",")
    const parts = db
      .query<
        { id: string; session_id: string; time_created: number; data: string; rowid: number; msg_data: string | null },
        string[]
      >(
        `SELECT p.id, p.session_id, p.time_created, p.data, p.rowid, m.data AS msg_data
         FROM part p LEFT JOIN message m ON m.id = p.message_id
         WHERE p.session_id IN (${placeholders})
         ORDER BY p.rowid`,
      )
      .all(...scoped)
    for (const part of parts) {
      const parsed = tryJson(part.data)
      const partType = typeof parsed?.type === "string" ? parsed.type : ""
      // AD18: excluded part types never reach category routing — dropped at the JOIN, so under
      // ANY config they produce zero rows (neither lifecycle nor a relocated Other). Read-side
      // only; the DB rows remain. Remove a value from EXCLUDED_EVENT_TYPES to re-want it.
      if (EXCLUDED_EVENT_TYPES.includes(partType)) continue
      const envelope = partEnvelope(part, router, childSet, capBytes)
      // AD22 — the length is measured HERE, in the read join, from the COMPLETE p.data text
      // this query already loads (the byte cap lives only inside partEnvelope for payload
      // bodies — an under-counted head must never become a reported length; DEC-I honesty).
      // Reasoning CATEGORY only (a config that claims the parts elsewhere gets no field);
      // spread appends the new key LAST, preserving the base five-key order.
      let rowEnvelope = envelope
      if (envelope.category === "reasoning" && typeof parsed?.text === "string") {
        rowEnvelope = { ...envelope, contentChars: parsed.text.length }
      }
      // Task 4b: synthetic text parts defer to the nudges lane when the column exists;
      // without it they keep ordinary part mapping (degrade visibly, never silently).
      if (nudgesColumn !== undefined && partType === "text" && parsed?.synthetic === true) {
        // AD36 (C), AD27 field pattern: scoped optional field on NUDGE ROWS ONLY, appended LAST
        // when present; every other envelope stays byte-identical. Value = the record's own
        // header token, lowercased, NOTHING re-derived (census lane updated as named change).
        const nudgeKind = nudgeKindFrom(parsed?.text)
        syntheticCandidates.push({
          ms: part.time_created,
          rowid: part.rowid,
          partId: part.id,
          envelope: { ...envelope, category: nudgesColumn.id, ...(nudgeKind !== undefined ? { nudgeKind } : {}) },
        })
        continue
      }
      rows.push({ ms: part.time_created, bucket: 0, sub: part.rowid, envelope: rowEnvelope })
    }
  } catch (error) {
    return { ok: false, code: "DB_UNREADABLE", message: error instanceof Error ? error.message : String(error) }
  } finally {
    db?.close()
  }

  // -- history.jsonl -----------------------------------------------------------
  if (input.sessionPath !== undefined) {
    const historyText = input.io.read(path.join(input.sessionPath, "history.jsonl"))
    if (historyText !== undefined) {
      const transitionCat = router.historyEventCategory("persona.transition")
      // AD37 (R1): 'other' is the catch-all — a history row that lands there has no lane to
      // describe it, but ITS OWN record does. Field = line.event verbatim (no transformation),
      // scoped to catch-all HISTORY rows ONLY: part feeds (both arms) and every routed row keep
      // byte-identical envelopes; a non-string identifier simply gets NO field.
      const catchAllId = router.catchAllId()
      const lines = historyText.split("\n")
      lines.forEach((raw, index) => {
        if (raw.length === 0) return
        const line = tryJson(raw)
        if (line === undefined) return // invalid (non-JSON) line: SKIP, stream continues (§6.4/AC5)
        if (typeof line.ts !== "string" || typeof line.event !== "string") return
        // AD36 (A) — display-exclusion holds on ANY source path: the same named constant the DB
        // arm applies governs the history arm too (the card's "whatever the source path").
        if (EXCLUDED_EVENT_TYPES.includes(line.event)) return
        const ms = Date.parse(line.ts)
        if (Number.isNaN(ms)) return
        const subAgent = typeof line.subAgentSessionId === "string" ? line.subAgentSessionId : undefined
        const parentKey = typeof line.parentSessionId === "string" ? line.parentSessionId : undefined
        const lineSession = typeof line.sessionId === "string" ? line.sessionId : ""
        // keep: own lines, lines parented here via history keys, or lines from DB-known children
        const dbLinked = subAgent !== undefined && childSet.has(subAgent)
        if (!(lineSession === "" || lineSession === input.sessionId || parentKey === input.sessionId || dbLinked)) return
        const category = router.historyEventCategory(line.event)
        const lineage =
          dbLinked ? ({ lineage: "db-parent" } as const) // BOTH arms present → the DB arm wins
          : subAgent !== undefined && parentKey === input.sessionId
            ? ({ lineage: "history-subagent" } as const) // history keys only
            : {}
        const detailsObject = typeof line.details === "string" ? tryJson(line.details) : undefined
        if (line.event === "plugin.nudge" && typeof detailsObject?.ref_part_id === "string") {
          attributedRefIds.add(detailsObject.ref_part_id) // suppression authority (Task 4b)
        }
        const isNudge = line.event === "plugin.nudge" && nudgesColumn !== undefined
        const envelope: TimelineEnvelope = {
          category,
          ts: line.ts,
          sourceRef: {
            kind: "historyLine",
            file: "history.jsonl",
            line: index + 1,
            sessionId: subAgent ?? lineSession,
            ...(category === transitionCat && (line.event === "persona.transition" || line.event === "TRN")
              ? { bankAuthoritative: true as const }
              : {}),
            ...(isNudge && typeof detailsObject?.ref_part_id === "string" ? { ref_part_id: detailsObject.ref_part_id } : {}),
            ...(isNudge ? { attributed: true as const } : {}),
            ...lineage,
          },
          summary: historySummary(line.event, detailsObject, typeof line.details === "string" ? line.details : undefined),
          payloadRef: { kind: "historyLine", file: "history.jsonl", line: index + 1, ...truncationFor(raw, capBytes) },
          ...(category === catchAllId && typeof line.event === "string" ? { historyEvent: line.event } : {}), // LAST key — named sixth-key census (ad37 join lane pins both sides)
        }
        rows.push({ ms, bucket: 1, sub: index, envelope })
      })
    }

    // -- legacy judge auto-detect (§5.1-5): file PRESENCE is the detector --------
    const judgeText = input.io.read(path.join(input.sessionPath, "materials", "judge-records.jsonl"))
    if (judgeText !== undefined) {
      const judgeCategory = router.historyEventCategory("plugin.judge")
      judgeText.split("\n").forEach((raw, index) => {
        if (raw.length === 0) return
        const record = tryJson(raw)
        if (record === undefined) return
        if (typeof record.ts !== "string") return
        const ms = Date.parse(record.ts)
        if (Number.isNaN(ms)) return
        const envelope: TimelineEnvelope = {
          category: judgeCategory,
          ts: record.ts,
          sourceRef: {
            kind: "historyLine",
            file: "materials/judge-records.jsonl",
            line: index + 1,
            sessionId: typeof record.sid === "string" ? record.sid : "",
          },
          summary: `judge ${String(record.kind ?? "?")} @ ${String(record.node ?? "?")}`,
          payloadRef: {
            kind: "historyLine",
            file: "materials/judge-records.jsonl",
            line: index + 1,
            ...truncationFor(raw, capBytes),
          },
        }
        rows.push({ ms, bucket: 2, sub: index, envelope })
      })
    }
  }

  // Task 4b materialization: fallback rows survive only where NO attributed nudge line
  // already represents the part (attributed wins; never duplicated; no phantom rows).
  for (const candidate of syntheticCandidates) {
    if (attributedRefIds.has(candidate.partId)) continue
    rows.push({
      ms: candidate.ms,
      bucket: 0,
      sub: candidate.rowid,
      envelope: {
        ...candidate.envelope,
        // synthetic candidates come only from part rows -> the dbId arm, always;
        // the explicit kind keeps the discriminated union narrowing sound.
        sourceRef: candidate.envelope.sourceRef.kind === "dbId" ? { ...candidate.envelope.sourceRef, kind: "dbId", attributed: false } : candidate.envelope.sourceRef,
      },
    })
  }

  rows.sort((a, b) => a.ms - b.ms || a.bucket - b.bucket || a.sub - b.sub)
  let ordered = rows.filter((row) => inRange(row.ms, fromMs, toMs)).map((row) => row.envelope)
  if (input.filters.categories !== undefined) {
    const wanted = new Set(input.filters.categories)
    ordered = ordered.filter((envelope) => wanted.has(envelope.category))
  }
  return { ok: true, envelopes: ordered }
}

const inRange = (ms: number, fromMs: number, toMs: number): boolean => ms >= fromMs && ms <= toMs

function partSummary(partType: string, data: Record<string, unknown> | undefined): string {
  const text = (value: unknown, max = 140): string => (typeof value === "string" ? value.slice(0, max) : "")
  switch (partType) {
    case "text":
    case "reasoning":
      return text(data?.text)
    case "tool": {
      const state = (data?.state ?? {}) as Record<string, unknown>
      return `${String(data?.tool ?? "tool")} ${JSON.stringify(state.input ?? {}).slice(0, 100)}`
    }
    case "step-start":
      return `step-start ${text(data?.snapshot, 12)}`
    case "step-finish":
      return `step-finish ${text(data?.reason, 40)}`
    case "patch":
      return `patch ${text(data?.hash, 12)}`
    case "compaction":
      return `compaction auto=${String(data?.auto ?? false)}`
    case "file":
      return `file ${text(data?.filename, 80)}`
    default:
      return partType.length > 0 ? partType : "unknown-part"
  }
}

function historySummary(
  event: string,
  details: Record<string, unknown> | undefined,
  detailsRaw: string | undefined,
): string {
  if ((event === "persona.transition" || event === "TRN") && details !== undefined) {
    // summary fields come from the JSON-PARSED details carrier (DEC-L), never the raw string
    const nodeId = typeof details.node_id === "string" ? details.node_id : "?"
    const target = typeof details.target_node === "string" ? details.target_node : "?"
    return `${nodeId} → ${target}`
  }
  // v14 (Design v1 traceability) — the receipt-shaped names. Their details are RAW "k=v …"
  // strings (the history.mjs --message shape — never JSON), so they read from detailsRaw,
  // the ONE place the truth exists. No new categories, no invented fields: the line says
  // exactly what the record says. Unknown events keep the byte-identical event-name fallback.
  if (event === "nudge-delivered" && detailsRaw !== undefined) {
    const kind = /(?:^|\s)kind=(\S+)/.exec(detailsRaw)?.[1]
    const node = /(?:^|\s)node=(\S+)/.exec(detailsRaw)?.[1]
    // ONE separator after the verb — the kv fields keep the record's OWN spacing
    const fields: string[] = []
    if (kind !== undefined) fields.push(`kind=${kind}`)
    if (node !== undefined) fields.push(`node=${node}`)
    return fields.length === 0 ? "received" : `received · ${fields.join(" ")}`
  }
  if ((event === "judge-assess" || event === "judge-summary") && detailsRaw !== undefined) {
    // verbatim kv text (the coach's own line IS the record); display-bounded like every summary
    const cap = 140
    return detailsRaw.length <= cap ? detailsRaw : detailsRaw.slice(0, cap) + "…"
  }
  return event
}

function tryJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function validateFilters(input: BuildTimelineInput): TimelineFailure | undefined {
  const { from, to, categories } = input.filters
  for (const [name, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      return { ok: false, code: "INVALID_FILTER", message: `${name}: expected an ISO-8601 timestamp (got "${value}")` }
    }
  }
  const configured = new Set(input.config.categories.map((category) => category.id))
  for (const wanted of categories ?? []) {
    if (!configured.has(wanted)) {
      return { ok: false, code: "INVALID_FILTER", message: `categories: "${wanted}" is not a configured column` }
    }
  }
  return undefined
}

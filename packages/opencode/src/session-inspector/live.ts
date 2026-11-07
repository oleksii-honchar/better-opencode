// Task 6 — live tail: internal bus -> inspector envelopes (§5.1-1 live bullet, §6.6).
//
// OD-1 IMPLEMENTER DECISION (full measurement in materials/task6-live-tail-evidence.md):
// SSE over the module's raw router, NOT a second websocket. Measured in the FORK
// (2026-11-04): the existing WS plumbing (/global/event — groups/global.ts payload union,
// Socket.layerWebSocketConstructorGlobal at server.ts:121/152, handlers/global.ts) is
// bound to the typed HttpApi surface and carries RAW engine payloads for ALL directories;
// reusing it would push category/summary mapping into the client (breaking SC-2 and the
// ratified server-side timeline job) and force this raw-route module into HttpApi groups.
// SSE keeps the §6.6 guarantee exactly: the frame body is "data: " + the EXACT NDJSON
// line bytes + "\n\n" — one client parser, one envelope authority.
//
// Envelope identity: part rows are turned into envelopes by timeline.ts's partEnvelope —
// the SAME function buildTimeline uses — read back from the DB via rowLookup (mirror of
// the projector, projectors.ts measured 2026-11-04: part row time_created = event.time,
// data = part minus id/messageID/sessionID). The event BODY is never rendered: if the
// row is not yet visible in the read-only DB, null is returned and the reload path
// (full rebuild from DB) covers it. DB stays the single rebuild source.

import type { CategoryRouter } from "./category-mapper"
import { EXCLUDED_EVENT_TYPES, partEnvelope } from "./timeline"
import type { PartRowView, TimelineEnvelope } from "./timeline"

export const SESSION_INSPECTOR_LIVE_PATH = "/session-inspector/session/:sessionID/live"

/** Wire shape of a bus payload (bus/index.ts Payload: id/type/properties). */
export interface LiveEventPayload {
  id: string
  type: string
  properties: unknown
}

export interface LiveContext {
  /** the session whose live view this stream serves */
  sessionId: string
  router: CategoryRouter
  capBytes: number
  /** read-only DB lookup; undefined when the row is not visible (or was removed) */
  rowLookup: (partId: string) => PartRowView | undefined
  /** direct children of sessionId (same scope rule as buildTimeline) */
  childIds: readonly string[]
}

const inScope = (sessionID: unknown, ctx: LiveContext): sessionID is string =>
  typeof sessionID === "string" && (sessionID === ctx.sessionId || ctx.childIds.includes(sessionID))

/**
 * One bus event -> zero or one envelope. Unknown/out-of-scope kinds return null:
 * nothing is ever silently mapped (unknown event types never fall into catch-all columns).
 */
export function liveEnvelopeFor(event: LiveEventPayload, ctx: LiveContext): TimelineEnvelope | null {
  const props = (event.properties ?? {}) as Record<string, unknown>

  if (event.type === "message.part.updated") {
    if (!inScope(props.sessionID, ctx)) return null
    const part = props.part as { id?: unknown } | undefined
    if (typeof part?.id !== "string") return null
    const row = ctx.rowLookup(part.id)
    if (row === undefined) return null // DB is the source; reload rebuilds — never render the event body
    // AD36 (A) — THE LEAK'S LAYER: the join filtered step-* (AD18) but this live push path mapped
    // every part type through the shared partEnvelope, so a live view streamed lifecycle step cells
    // back in. The live path is a display path too: the same constant drops the same rows here.
    // Read-side only; the DB rows are untouched.
    let partType = ""
    try {
      const parsed = JSON.parse(row.data) as { type?: unknown } | null
      if (parsed && typeof parsed.type === "string") partType = parsed.type
    } catch {
      // unparseable data: partEnvelope already renders it neutrally — no type to exclude on
    }
    if (EXCLUDED_EVENT_TYPES.includes(partType)) return null
    return partEnvelope(row, ctx.router, new Set(ctx.childIds), ctx.capBytes)
  }

  if (event.type === "message.part.removed") {
    if (!inScope(props.sessionID, ctx)) return null
    if (typeof props.partID !== "string") return null
    // envelope kept strictly 5-key like every timeline line; the client removes the cell
    // by sourceRef.dbId and the drawer resolves the (now absent) payload explicitly.
    return {
      category: "other", // no row/type left to map; the removed marker is what clients key on
      ts: new Date().toISOString(),
      sourceRef: { kind: "dbId", dbId: props.partID, sessionId: String(props.sessionID), removed: true },
      summary: `part ${props.partID} removed`,
      payloadRef: { kind: "dbId", dbId: props.partID },
    }
  }

  if (event.type === "session.idle" || event.type === "permission.asked" || event.type === "permission.replied") {
    if (!inScope(props.sessionID, ctx)) return null
    // config decides the column (historyEvents arm matches the live event name;
    // default sets declare none of these -> catch-all 'other', never a silent drop).
    const category = ctx.router.historyEventCategory(event.type)
    const detail = typeof props.pattern === "string" ? ` ${props.pattern}` : ""
    return {
      category,
      ts: new Date().toISOString(),
      sourceRef: { kind: "liveEvent", event: event.type, sessionId: String(props.sessionID), busEventId: event.id },
      summary: `${event.type}${detail}`,
      payloadRef: null, // bare event has no payload source; the drawer says so explicitly
    }
  }

  return null
}

/** SSE frame body: the NDJSON line bytes with the SSE data-field prefix (§6.6 identical shape). */
export function liveSseFrameBody(envelope: TimelineEnvelope): string {
  return `data: ${JSON.stringify(envelope)}\n\n`
}

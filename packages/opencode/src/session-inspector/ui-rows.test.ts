import { describe, expect, test } from "bun:test"
// AD7 — row-assignment PURE CORE: the vertical spine of the grid. One data point
// = one row slot (strict 1:1); rows ordered by ts ACROSS all columns; same-ts
// events get distinct adjacent rows with a DETERMINISTIC secondary order:
//   ts asc  ->  colRank asc (config column order)  ->  seq asc (per-column arrival)
// The renderer inserts rows one at a time (NDJSON stream + live SSE arrive over
// time), so the core is an INSERT-POSITION function; full rebuild = same inserts.
import { rowInsert, type RowKey } from "./ui"

const k = (ts: string, colRank: number, seq: number): RowKey => ({ ts, colRank, seq })
const cmp = (a: RowKey, b: RowKey) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.colRank - b.colRank || a.seq - b.seq)
const feed = (items: RowKey[]) => {
  const rows: RowKey[] = []
  for (const it of items) rows.splice(rowInsert(rows, it), 0, it)
  return rows
}

describe("ad7 rowInsert core — 1:1, ts-monotonic union timeline, deterministic tie-order", () => {
  test("pure: never mutates, returns index 0 on empty", () => {
    const rows: RowKey[] = []
    expect(rowInsert(rows, k("2026-11-04T20:00:00.000Z", 0, 0))).toBe(0)
    expect(rows.length).toBe(0)
  })

  test("stream ascending appends at tail; late/out-of-order events splice into the middle", () => {
    const items = [k("2026-11-04T20:00:02.000Z", 1, 0), k("2026-11-04T20:00:00.000Z", 0, 0), k("2026-11-04T20:00:01.000Z", 2, 0), k("2026-11-04T20:00:00.500Z", 1, 1)]
    const rows = feed(items)
    expect(rows.map((r) => r.ts)).toEqual(["2026-11-04T20:00:00.000Z", "2026-11-04T20:00:00.500Z", "2026-11-04T20:00:01.000Z", "2026-11-04T20:00:02.000Z"])
  })

  test("SAME-ts events occupy distinct adjacent rows ordered by colRank then seq", () => {
    const T = "2026-11-04T20:00:07.000Z"
    const rows = feed([k(T, 2, 0), k(T, 0, 1), k(T, 0, 0), k(T, 1, 5), k("2026-11-04T20:00:06.900Z", 9, 9), k(T, 2, 1)])
    expect(rows.map((r) => `${r.ts.slice(17, 24)} ${r.colRank}:${r.seq}`)).toEqual(["06.900Z 9:9", "07.000Z 0:0", "07.000Z 0:1", "07.000Z 1:5", "07.000Z 2:0", "07.000Z 2:1"])
  })

  test("1:1 + monotone property battery (200 mixed same-ts points, deterministic under arrival order)", () => {
    const pts: RowKey[] = []
    for (let i = 0; i < 200; i++) pts.push(k("2026-11-04T20:00:" + String(i % 37).padStart(2, "0") + ".000Z", i % 12, Math.floor(i / 12)))
    const a = feed(pts)
    const b = feed(pts.slice().reverse())
    expect(a.length).toBe(200)
    expect(a.map((r) => r.colRank + ":" + r.seq)).toEqual(b.map((r) => r.colRank + ":" + r.seq))
    for (let i = 1; i < a.length; i++) expect(cmp(a[i - 1], a[i])).toBeLessThanOrEqual(0)
  })

  test("insertion index semantics: result always in [0, rows.length]; duplicates keep stable adjacency", () => {
    const rows = feed([k("T1", 0, 0), k("T1", 0, 1)])
    expect(rowInsert(rows, k("T1", 0, 0))).toBe(1) // full-duplicate lands AFTER its equal ({0,0}) at index 0 -> index 1; stable upper-bound of the EQUAL CLASS, not end-of-list
    expect(rowInsert(rows, k("T1", 0, 2))).toBe(2)
    expect(rowInsert(rows, k("T0", 5, 5))).toBe(0)
    expect(rowInsert(rows, k("T2", 0, 0))).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// AD9 — floating hover card PURE CORES (namespace access: an unimplemented core
// must RED only this lane). Floating-ui FEEL, zero-deps: hand-rolled flip/shift
// placement + pinned pure truncation for the card preview.
import * as uiRows from "./ui"
const a9 = uiRows as unknown as Record<string, any>
const a9Need = (name: string): any => {
  if (a9[name] === undefined) throw new Error("ad9 core missing: " + name)
  return a9[name]
}

describe("ad9 computePopoverPlacement — hand-rolled floating-ui semantics", () => {
  const V = { left: 0, top: 0, width: 1000, height: 800 }
  const CARD = { width: 320, height: 180 }
  const G = 8 // explicit gap so arithmetic is transparent
  const rect = (x: number, y: number, w = 86, h = 28) => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h })
  const fit = (p: { x: number; y: number }) => ({
    l: p.x >= V.left, t: p.y >= V.top, r: p.x + CARD.width <= V.left + V.width, b: p.y + CARD.height <= V.top + V.height,
  })

  test("constants exported with pinned values", () => {
    expect(a9Need("POPOVER_GAP_PX")).toBe(G)
    expect(a9Need("POPOVER_EDGE_MARGIN_PX")).toBe(8)
    expect(a9Need("POPOVER_INTENT_MS")).toBe(150)
    expect(a9Need("POPOVER_PREVIEW_CAP")).toBe(400)
  })

  test("centered below by default (placement 'bottom'); exact anchor math", () => {
    const p = a9Need("computePopoverPlacement")(rect(400, 300), V, CARD, G, 8)
    expect(p.placement).toBe("bottom")
    expect(p.x).toBe(400 + 43 - 160) // anchor center x - card/2 = 283
    expect(p.y).toBe(328 + G)
    expect(fit(p)).toEqual({ l: true, t: true, r: true, b: true })
  })

  test("vertical flip to TOP when bottom would clip; still fits", () => {
    const p = a9Need("computePopoverPlacement")(rect(400, 700), V, CARD, G, 8)
    expect(p.placement).toBe("top")
    expect(p.y).toBe(700 - 180 - G) // anchor.top - card.h - gap = 512
    expect(fit(p).b).toBe(true)
    expect(fit(p).t).toBe(true)
  })

  test("top also clipped (short viewport) → 'center' with BOTH vertical clamps active", () => {
    const Vshort = { left: 0, top: 0, width: 1000, height: 200 }
    const p = a9Need("computePopoverPlacement")(rect(400, 90, 86, 28), Vshort, CARD, G, 8)
    expect(p.placement).toBe("center")
    expect(p.y).toBe(12) // clamp [margin, vh-card-margin] = [8, 200-180-8=12]; center 14 clamps to yMax=12 — in-viewport
    expect(p.y + CARD.height).toBeLessThanOrEqual(200 - 8)
  })

  test("horizontal shift: right-edge and left-edge anchors clamp by exactly margin", () => {
    const r = a9Need("computePopoverPlacement")(rect(970, 300), V, CARD, G, 8)
    expect(r.x).toBe(1000 - 320 - 8)
    expect(fit(r).r).toBe(true)
    const l = a9Need("computePopoverPlacement")(rect(10, 300), V, CARD, G, 8)
    expect(l.x).toBe(8)
    expect(fit(l).l).toBe(true)
  })

  test("pure: never mutates its arguments", () => {
    const a = rect(50, 50)
    const aCopy = JSON.stringify(a)
    const vCopy = JSON.stringify(V)
    a9Need("computePopoverPlacement")(a, V, CARD, G, 8)
    expect(JSON.stringify(a)).toBe(aCopy)
    expect(JSON.stringify(V)).toBe(vCopy)
  })
})

describe("ad9 hoverPreviewText — pinned truncation for the card preview", () => {
  test("short text passes through unchanged (no marker)", () => {
    const r = a9Need("hoverPreviewText")("short summary text")
    expect(r.text).toBe("short summary text")
    expect(r.capped).toBe(false)
    expect(r.displayedLength).toBe("short summary text".length) // 18 chars, measured not counted
  })

  test("cap boundary: length exactly POPOVER_PREVIEW_CAP → uncapped; one over → total length == cap, ends with …", () => {
    const CAP: number = a9Need("POPOVER_PREVIEW_CAP")
    const edge = "x".repeat(CAP)
    expect(a9Need("hoverPreviewText")(edge).capped).toBe(false)
    const over = a9Need("hoverPreviewText")("x".repeat(CAP + 1))
    expect(over.capped).toBe(true)
    expect(over.text.length).toBe(CAP)
    expect(over.text.endsWith("…")).toBe(true)
  })

  test("nullish/empty → empty honest '' (renderer owns absent wording), never throws", () => {
    const f = a9Need("hoverPreviewText")
    expect(f("").text).toBe("")
    expect(f(undefined as any).text).toBe("")
    expect(f(null as any).text).toBe("")
    expect(f(123 as any).text).toBe("")
  })
})

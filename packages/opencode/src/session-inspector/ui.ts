import { HttpServerResponse } from "effect/unstable/http"

// Task 5 - the Session Inspector page (DEC-A option B: self-contained HTML served at
// /session-inspector/ by this module; vanilla ES, hyperscript-style helper, ZERO new
// dependencies and zero build step). All grid knowledge (columns, order, cell size)
// comes from GET /session-inspector/config at runtime - never from this source (SC-2).
// Timeline rows stream in NDJSON and are appended incrementally line-by-line (§6.6);
// the drawer resolves payloads through the ratified grammar {resolved,kind,source,
// payload,truncated,fullLength,sourceAbsent?} and renders source-absence explicitly.

export const SESSION_INSPECTOR_UI_PATH = "/session-inspector/"

export function uiHttpResponse(): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text(INSPECTOR_UI_HTML, { contentType: "text/html; charset=utf-8" })
}

// ── AD-UI (owner instruction 2026-11-04): sidebar resize + theme — PURE CORES ──
// These numbers/functions are the SINGLE SOURCE: the page receives them injected
// (toString / interpolated constants), and ui.test.ts pins them directly.
// Clamps keep the sidebar readable (never collapsible) and grid-safe (never
// overlapping). Grid CELL sizes stay 100% from /session-inspector/config at
// runtime (SC-2) — resizing affects sidebar width ONLY.

export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 640
export const SIDEBAR_DEFAULT_WIDTH = 280 // matches the pre-existing fixed width
export const SIDEBAR_WIDTH_KEY = "session-inspector:sidebar-width"
export const THEME_CHOICE_KEY = "session-inspector:theme"

export function clampSidebarWidth(v: number): number {
  if (!Number.isFinite(v)) return SIDEBAR_DEFAULT_WIDTH // garbage (NaN/undefined) → known-good default
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, v)) // numeric-but-invalid (0/-x) → MIN (never collapsible)
}

export function decodeStoredWidth(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return clampSidebarWidth(n)
}

// ── AD-HOC owner task 2 (2026-11-04): responsive 100 %-width grid ────────────
// SUPERSEDED-IN-PLACE by AD10 (owner 2026-11-05): the flex-stretch template
// (minmax(GRID_COL_MIN_PX,1fr) per column) is REPLACED by fixed narrow left-aligned
// tracks — named delta, recorded in task-ad10 evidence. What still stands from AD2:
// config owns column SET/ORDER (never this function), the stage stays the scroll
// context, and no page scroll ever exists.

export const GRID_TRACK_PX = 64 // one block + its gutter (AD10 card ruling 4: ≈64 px/track)

export function gridTrackTemplate(n: number): string {
  if (n <= 0) return ""
  return `repeat(${n}, ${GRID_TRACK_PX}px)`
}

// AD3 — stable testid hooks (behavior-neutral; pure naming cores, single source:
// the served page injects THESE functions' compiled text, unit tests import them).
// Scheme (full table: materials/task-ad3-evidence.md):
//   static landmarks: si-header si-theme-toggle si-sidebar si-filter si-filter-dock
//     si-session-list si-resizer si-stage si-livebar si-live-status si-live-toggle
//     si-grid si-empty si-drawer | drawer parts (runtime): si-drawer-meta
//     si-drawer-payload si-drawer-note si-drawer-source-absent | si-sessions-empty (absent-state)
//     si-payload-mode-tree si-payload-mode-raw si-payload-expand-all si-payload-collapse-all
//     si-payload-fallback-note  (AD8: payload mode switch + tree controls; nodes carry join-safe data-path)
//     si-hover-card si-hover-card-ts si-hover-card-cat si-hover-card-src si-hover-card-preview
//       (AD9: ONE reused floating hover card shown from a 150 ms hover intent)
//     (si-filter-dock added AD6: sticky sidebar head wrapper; input id/testid unchanged)
//   data-suffixed (runtime, via cores below): si-session-row-<sid>
//     si-column-<catId> si-col-header-<catId> si-cell-<catId>-<seq>
// Existing seams (data-sid / data-cat / data-category) are KEPT — consolidated,
// not duplicated.

export function siRowTestId(sid: string): string {
  return "si-session-row-" + sid
}

export function siColTestId(catId: string): string {
  return "si-column-" + catId
}

export function siColHeaderTestId(catId: string): string {
  return "si-col-header-" + catId
}

export function siCellTestId(catId: string, seq: number): string {
  return "si-cell-" + catId + "-" + seq
}

// AD4 keyboard semantic (exact focus semantics pinned in ui.test.ts): the
// document-level handler closes the drawer ONLY on key === "Escape" while it is
// open. Every other key — including sidebar-filter typing — is a strict no-op,
// and Escape while closed is a no-op. No focus management, no preventDefault.

export function escShouldCloseDrawer(key: string, drawerOpen: boolean): boolean {
  return key === "Escape" && drawerOpen
}

// AD5 — resizable drawer (persona-graph #dragbar idiom mirrored: 7px col-resize
// bar, visible only while the drawer is open). Pure cores, single source: the
// page injects their compiled text; unit tests import them.
// Clamp composition (pinned): [DRAWER_MIN_WIDTH, min(DRAWER_MAX_WIDTH,
// vw - sidebarWidth - DRAWER_VIEWPORT_GUTTER)] and when the viewport-fit max
// falls BELOW the min, the FIT WINS (AD2: the drawer can never force overflow).
// DRAWER_DEFAULT_WIDTH=360 is the AD5 constant (supersedes the 380px
// :root-era default — flagged in evidence), persisted via the AD1 pattern.

export const DRAWER_MIN_WIDTH = 240
export const DRAWER_MAX_WIDTH = 720
export const DRAWER_DEFAULT_WIDTH = 360
export const DRAWER_VIEWPORT_GUTTER = 14
// AD5 exact viewport-fit composition (implementer call, pinned + documented):
// max = min(DRAWER_MAX_WIDTH, vw - sidebar - DRAWER_FIT_RESERVE) where the
// reserve = 14 (AD2 gutter vocabulary) + 9 (divider box: 7px + 2px border-left)
// + 24 (stage minimum: flex min-width:0 leaves its padding box) = 47. Without
// this the open drawer + divider overflowed the page at narrow vw (caught live,
// 717 vs 700 — measured sibling rects).
export const DRAWER_DIVIDER_BOX = 9
export const DRAWER_STAGE_MIN = 24
export const DRAWER_FIT_RESERVE = DRAWER_VIEWPORT_GUTTER + DRAWER_DIVIDER_BOX + DRAWER_STAGE_MIN
export const DRAWER_WIDTH_KEY = "session-inspector:drawer-width"

export function clampDrawerWidth(raw: number, viewportWidth: number, sidebarWidth: number): number {
  const fitMax = Math.min(DRAWER_MAX_WIDTH, viewportWidth - sidebarWidth - DRAWER_FIT_RESERVE)
  if (!Number.isFinite(raw)) return Math.round(Math.min(DRAWER_MIN_WIDTH, fitMax))
  const min = Math.min(DRAWER_MIN_WIDTH, fitMax) // narrow viewport: fit wins over the 240 floor
  if (raw < min) return min
  if (raw > fitMax) return Math.round(fitMax)
  return Math.round(raw)
}

export function decodeStoredDrawerWidth(stored: string | null): number | null {
  if (stored === null || stored.length === 0) return null
  const n = Number(stored)
  return Number.isFinite(n) ? n : null
}

// AD7 — timestamp-keyed 1:1 row assignment (owner 2026-11-04: "every data point
// gets its OWN row ... I can trace the sequence"). PURE CORE, single source: the
// page injects this compiled text; ui-rows.test.ts imports and property-tests it.
// Contract (documented tie-order): rows sort by ts ASC across ALL columns (union
// timeline); same-ts rows ordered by colRank (config column order), then seq
// (per-column arrival counter). rowInsert returns the splice index that keeps the
// array totally ordered; equal (ts,colRank,seq) duplicates land AFTER equals
// (stable). Pure: never mutates. Strict 1:1 lives in the renderer's use:
// appendCell creates exactly one row entry per accepted envelope and mirrors it
// into EVERY column (cell for the owner, .slot filler for the others).
export interface RowKey {
  ts: string
  colRank: number
  seq: number
}

// Row pitch (mini) metric — the 1:1 spine rhythm of AD7: one pitch unit per row in
// EVERY column. It lives as a CSS custom property (--cell-mini declared on #grid
// from this constant — one source, no px literals in the .cell rule per the L220
// config-discipline). The AD7 mini WIDTH metric (--cell-w / 86px) was RETIRED by
// AD10: the narrow fixed track IS the width now (named delta in ui.test.ts).
// AD11 NAMED SUPERSESSION (density contract, card ruling 1): the pitch is vertical
// box+gutter. The box now equals the block (14); the spacing is the fixed gutter
// token below. (AD11's governing ratio ceiling ≤1.25× was RETIRED by AD12 — the
// owner model is a fixed px gutter; history in task-ad11/-evidence.) Old values: box
// 28 (+8 literal margin = 36 pitch, 2.57× — measured baseline in task-ad11 JSON).
export const CELL_MINI_H_PX = 14
// AD11: the vertical row gutter. AD12 (owner 2026-11-05: "the gap should be not like
// factor of height, e.g. x0.2, but some fixed number, e.g. 4px") makes this THE model:
// a FIXED px gutter is the single source of the rhythm; the AD11 ratio-of-height
// ceiling (≤1.25×block) is retired as the governing contract (history: task-ad11
// evidence). The owner knob is exactly this one line: 4.
export const CELL_GUTTER_PX = 4
// AD12: the row PITCH is a DERIVED value — block box + fixed gutter. No independent
// pitch constant may exist (unit-pinned against the source); --cell-pitch serves this
// derivation to the page, and the vertical hit consumes the same chain (gap-0
// never-overlap invariant, re-derived at the new rhythm: hit ≡ pitch → gap 0).
export const CELL_PITCH_PX = CELL_MINI_H_PX + CELL_GUTTER_PX

// ── AD10 (owner 2026-11-05 with screenshot): contentless "arkanoid" blocks ────
// A cell is a solid COLOR BLOCK with ZERO content. These tokens are the single
// source (same var discipline as the mini metrics above): #grid declares them as
// custom properties from HERE; ui.test.ts pins them; the visible target is ~24×14
// and the hit area's HORIZONTAL comfort floor (40) is unchanged. The vertical hit
// token and its old floor (26) were superseded by AD11 card rule 2 and are now
// DERIVED from the fixed-gutter pitch (AD12): hit ≡ pitch, so adjacent hit rects
// touch at gap 0, never overlap; the floor is the visible block height (comfort
// never undercuts paint).
export const CELL_BLOCK_W_PX = 24
export const CELL_BLOCK_H_PX = 14
export const CELL_HIT_MIN_W_PX = 40
export const CELL_HIT_MIN_H_PX = 14
export const CELL_HIT_W_PX = 44
export const CELL_HIT_H_PX = CELL_PITCH_PX

// Per-lane block colors — a deterministic lane→color mapping over vendored STATIC
// hex constants (official palette values carried as data; no external CSS/JS, no
// build step, nothing fetched). F27 ruling (developer, from the owner's AC "different
// color to EACH column"): EVERY known lane key is explicit here — the full shipped
// §5.6 category vocabulary (config.schema defaults; the 12 fixture headers are the
// live evidence). The hash cycle serves ONLY unknown/config-renamed keys: degraded,
// never silent — and its hues are disjoint from every explicit hex.
// Dark theme = the SAME hues one step brighter (-400 of the -500/-600 light base).
// F27 palette rules, all pinned by the unit battery: pairwise Euclidean distance ≥35
// between known hues in BOTH modes (measured minima: 36.0 light, 38.1 dark); light
// slots clear the 2.1 absolute contrast floor on the rendered page surface, and the
// amber rule holds — tool-calls light is amber-600 (≥2.3). Where a -500 light step
// broke a floor, that one lane's light base is -600 (documented exceptions:
// tool-calls, amt-activity). user-messages moved sky→blue so its -400 pair keeps
// distance from pipeline's cyan; the catch-all "other" carries pink (its old hashed
// teal slot belongs to coach-activity's explicit hue now).
export const LANE_BLOCK_BASE: Record<string, { light: string; dark: string }> = {
  usermessages: { light: "#3b82f6", dark: "#60a5fa" },
  assistanttext: { light: "#10b981", dark: "#34d399" },
  reasoning: { light: "#8b5cf6", dark: "#a78bfa" },
  toolcalls: { light: "#d97706", dark: "#fbbf24" },
  transitions: { light: "#f43f5e", dark: "#fb7185" },
  pipeline: { light: "#0891b2", dark: "#22d3ee" },
  coachjudge: { light: "#6366f1", dark: "#818cf8" },
  coachactivity: { light: "#14b8a6", dark: "#2dd4bf" },
  amtactivity: { light: "#65a30d", dark: "#a3e635" },
  enginenudges: { light: "#f97316", dark: "#fb923c" },
  lifecycle: { light: "#d946ef", dark: "#e879f9" },
  other: { light: "#ec4899", dark: "#f472b6" },
}
// Overflow cycle (F27 v2): hues NO known lane uses — disjoint from all 24 explicit
// hexes so a renamed lane can never wear a known lane's color. sky is kept for
// continuity of renamed user-message ids; the rest are unclaimed palette hues.
export const LANE_BLOCK_OVERFLOW: { light: string[]; dark: string[] } = {
  light: ["#0ea5e9", "#ef4444", "#a855f7", "#16a34a", "#ca8a04"],
  dark: ["#38bdf8", "#f87171", "#c084fc", "#4ade80", "#facc15"],
}

// Contract (documented): keys normalize case + separators, so config ids
// ("user-messages") and canonical lane names ("userMessages") are the SAME lane.
// Malformed input never throws — it falls into the overflow branch. Any theme value
// that is not "dark" resolves to the light step (documented default).
export function laneBlockColor(laneKey: string, themeMode: "light" | "dark"): string {
  const raw = laneKey === null || laneKey === undefined ? "" : String(laneKey)
  const norm = raw.toLowerCase().replace(/[-_.\s]/g, "")
  const base = LANE_BLOCK_BASE[norm]
  if (base) return themeMode === "dark" ? base.dark : base.light
  let h = 0x811c9dc5 // FNV-1a 32-bit
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const idx = (h >>> 0) % LANE_BLOCK_OVERFLOW.light.length
  return themeMode === "dark" ? LANE_BLOCK_OVERFLOW.dark[idx] : LANE_BLOCK_OVERFLOW.light[idx]
}

export function rowInsert(rows: readonly RowKey[], item: RowKey): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const a = rows[mid]
    const c = a.ts < item.ts ? -1 : a.ts > item.ts ? 1 : a.colRank - item.colRank || a.seq - item.seq
    if (c <= 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

// AD8 — interactive JSON tree for the drawer payload (owner 2026-11-04: "find a
// way to render interactive json tree ... and switch between raw text and
// interactive json"; zero-deps ⇒ hand-rolled). PURE CORES, single source: the
// page injects .toString() + the interpolated constants below; ui.test.ts
// accesses them through the module namespace. Input is the payload TEXT exactly
// as jsonBlock would render it (same-source text for both modes). Nodes carry
// RFC6901-escaped JSON-pointer paths (join-safe data-path). Pure: never throws.
export const TREE_NODE_BUDGET = 2000 // tree render cap; exceeding → forced raw + honest notice
export const TREE_DEFAULT_EXPAND_DEPTH = 2 // fresh open: containers at depth < 2 expanded (root=0)

export interface JsonTreeNode {
  path: string
  key: string | null
  kind: "object" | "array" | "string" | "number" | "boolean" | "null"
  value?: unknown
  children?: JsonTreeNode[]
  count?: number
}
export interface JsonTreeModelOk {
  ok: true
  root: JsonTreeNode
  nodeCount: number
  overBudget: boolean
}
export interface JsonTreeModelFail {
  ok: false
  reason: "invalid-json"
}

export function jsonTreeModel(text: string): JsonTreeModelOk | JsonTreeModelFail {
  let data: unknown
  try {
    if (typeof text !== "string" || text.length === 0) return { ok: false, reason: "invalid-json" }
    data = JSON.parse(text)
  } catch (_e) {
    return { ok: false, reason: "invalid-json" }
  }
  const esc = (k: string): string => k.replace(/~/g, "~0").replace(/\//g, "~1")
  let nodeCount = 0
  const build = (v: unknown, path: string, key: string | null): JsonTreeNode => {
    nodeCount++
    if (v !== null && typeof v === "object") {
      const isArr = Array.isArray(v)
      const items = isArr ? (v as unknown[]) : undefined
      const keys = isArr ? (v as unknown[]).map((_x, i) => String(i)) : Object.keys(v as object)
      const children: JsonTreeNode[] = []
      for (const k of keys) {
        const raw = isArr ? (items as unknown[])[Number(k)] : (v as Record<string, unknown>)[k]
        children.push(build(raw, path + "/" + esc(k), isArr ? null : k))
      }
      return { path, kind: isArr ? "array" : "object", key, children, count: children.length }
    }
    const kind = v === null ? "null" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string"
    return { path, kind, key, value: v }
  }
  const root = build(data, "", null)
  return { ok: true, root, nodeCount, overBudget: nodeCount > TREE_NODE_BUDGET }
}

// Expand/collapse state — pure reducer. containers = every object/array path
// (incl. root), computed ONCE from the model; all later transitions are model-free.
export interface TreeUiState {
  expanded: string[]
  containers: readonly string[]
}

export function initialTreeState(root: JsonTreeNode): TreeUiState {
  const expanded: string[] = []
  const containers: string[] = []
  const walk = (n: JsonTreeNode, depth: number): void => {
    if (n.kind === "object" || n.kind === "array") {
      containers.push(n.path)
      if (depth < TREE_DEFAULT_EXPAND_DEPTH) expanded.push(n.path)
      for (const c of n.children || []) walk(c, depth + 1)
    }
  }
  walk(root, 0)
  return { expanded, containers }
}

export function treeStateReducer(state: TreeUiState, action: { type: string; path?: string }): TreeUiState {
  if (action.type === "toggle-node") {
    const p = action.path as string
    const has = state.expanded.includes(p)
    return { expanded: has ? state.expanded.filter((x) => x !== p) : [...state.expanded, p], containers: state.containers }
  }
  if (action.type === "expand-all") return { expanded: [...state.containers], containers: state.containers }
  if (action.type === "collapse-all") return { expanded: [], containers: state.containers }
  return state
}

// AD9 — floating hover card PURE CORES (owner 2026-11-04: "magnifier - probably
// it's bad idea - let's remove it, instead show only timestamp on each box and on
// hover show popup card with more details ... like floating-ui.com"). Zero-deps:
// hand-rolled flip/shift placement (floating-ui semantics, pure math). Single
// source: page injects .toString(); ui-rows.test.ts unit-tests every vector.
export const POPOVER_GAP_PX = 8
export const POPOVER_EDGE_MARGIN_PX = 8
export const POPOVER_INTENT_MS = 150
export const POPOVER_PREVIEW_CAP = 400

export interface PopoverRect {
  left: number
  top: number
  width: number
  height: number
}

// Placement contract (documented): prefer BOTTOM (center under anchor), FLIP to
// TOP when the bottom edge would clip; if BOTH clip (viewport taller-blocked),
// placement "center" with vertical clamp active; x is always SHIFTED (clamped)
// into [margin, vw - card.w - margin]. Returns top-left x,y in viewport coords
// (rendered into a position:fixed element — the floating-ui pattern). Pure:
// never mutates arguments.
export function computePopoverPlacement(
  anchor: PopoverRect,
  viewport: PopoverRect,
  card: { width: number; height: number },
  gap: number = POPOVER_GAP_PX,
  margin: number = POPOVER_EDGE_MARGIN_PX,
): { placement: "bottom" | "top" | "center"; x: number; y: number } {
  const vw = viewport.width
  const vh = viewport.height
  let x = viewport.left + anchor.left + anchor.width / 2 - card.width / 2
  const xMin = viewport.left + margin
  const xMax = viewport.left + vw - card.width - margin
  x = Math.min(Math.max(x, xMin), xMax)
  const below = viewport.top + anchor.top + anchor.height + gap
  const above = viewport.top + anchor.top - card.height - gap
  if (below + card.height <= viewport.top + vh - margin) return { placement: "bottom", x, y: below }
  if (above >= viewport.top + margin) return { placement: "top", x, y: above }
  const yMin = viewport.top + margin
  const yMax = viewport.top + vh - card.height - margin
  return { placement: "center", x, y: Math.min(Math.max(viewport.top + anchor.top + anchor.height / 2 - card.height / 2, yMin), yMax) }
}

// Card preview truncation — pinned pure cap; the FULL text always remains one
// click away in the drawer. Nullish inputs → honest "" (renderer chooses wording).
export function hoverPreviewText(text: string | undefined | null): { text: string; capped: boolean; displayedLength: number } {
  if (typeof text !== "string" || text.length === 0) return { text: "", capped: false, displayedLength: 0 }
  if (text.length <= POPOVER_PREVIEW_CAP) return { text, capped: false, displayedLength: text.length }
  const t = text.slice(0, POPOVER_PREVIEW_CAP - 1) + "…"
  return { text: t, capped: true, displayedLength: t.length }
}

export const INSPECTOR_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session Inspector</title>
<style>
  :root {
    --bg: #101318; --panel: #171b22; --line: #2a3140; --ink: #d7dce5; --dim: #8b96a8;
    --accent: #6fa8ff; --badge: #24344d; --warn: #d2a557; --drawer: 380px;
    --tooltip: #0b0e12; --folder-bg: #3b2f22; --live-on: #76c97d;
  }
  [data-theme="light"] {
    --bg: #f4f6f9; --panel: #ffffff; --line: #cfd6e0; --ink: #1a2130; --dim: #5c6675;
    --accent: #2b62c9; --badge: #dce8fa; --warn: #8a5a1f;
    --tooltip: #ffffff; --folder-bg: #f0e3c8; --live-on: #1d7a3a;
  }
  * { box-sizing: border-box; }
  /* AD6 viewport-height app shell: the page NEVER scrolls (page-scroll stays
     0 by construction); scrolling lives in two independent regions, each with
     its own pinned head: the sidebar (filter dock sticky) and the stage
     (livebar + column headers sticky). Plain-CSS sheet: slash-slash would
     void the rules below it (F20), comments here stay block-style. */
  body { margin: 0; overflow: hidden; background: var(--bg); color: var(--ink); font: 13px/1.45 system-ui, sans-serif; }
  header { box-sizing: border-box; height: 44px; padding: 10px 16px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: center; background: var(--bg); } /* AD6: fixed 44px band = the constant every 100vh - 44px / top: 44px in this sheet references */
  header h1 { font-size: 15px; margin: 0; }
  header #status { color: var(--dim); }
  #themeToggle { margin-left: auto; width: 30px; height: 30px; padding: 0; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; flex: none; }
  #themeToggle svg { width: 16px; height: 16px; display: block; margin: auto; }
  #themeToggle .i-moon { display: none; }                     /* dark (default): sun icon offers the flip */
  [data-theme="light"] #themeToggle .i-sun { display: none; } /* light: moon icon */
  [data-theme="light"] #themeToggle .i-moon { display: block; }
  main { display: flex; height: calc(100vh - 44px); overflow: hidden; } /* AD6: fixed shell; children are the scroll contexts */
  #sidebar { width: var(--sidebar-w, 280px); border-right: 1px solid var(--line); padding: 10px; flex: none; overflow-y: auto; } /* AD6: full shell-height own scroller (stretch child; max-height trick retired) */
  #resizer { flex: none; width: 6px; margin: 0 -3px; cursor: col-resize; background: var(--line); opacity: 0.35; }
  #resizer:hover, #resizer.active { opacity: 1; }
  body.resizing { cursor: col-resize; user-select: none; }
  #filterdock { position: sticky; top: 0; z-index: 3; background: var(--bg); padding-bottom: 8px; } /* AD6: the sidebar's pinned head; occludes rows sliding under the filter */
  #filter { width: 100%; padding: 6px 8px; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; }
  #sessions .row { padding: 6px 8px; border-radius: 6px; cursor: pointer; margin-bottom: 2px; }
  #sessions .row:hover { background: var(--panel); }
  #sessions .row.selected { background: var(--badge); }
  #sessions .row.child { margin-left: 18px; border-left: 2px solid var(--line); }
  #sessions .r1 { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #sessions .r2 { color: var(--dim); font-size: 11px; display: flex; gap: 6px; align-items: center; }
  .tag { font-size: 10px; padding: 0 6px; border-radius: 8px; background: var(--badge); color: var(--accent); }
  .tag.folder { background: var(--folder-bg); color: var(--warn); }
  #stage { flex: 1; min-width: 0; overflow: auto; padding: 0 12px 12px; } /* AD6: top gutter owned by the sticky livebar, not scrollable padding */
  #grid { display: grid; gap: 10px; --cell-mini: ${CELL_MINI_H_PX}px; --cell-gutter: ${CELL_GUTTER_PX}px; --cell-pitch: ${CELL_PITCH_PX}px; --cell-block-w: ${CELL_BLOCK_W_PX}px; --cell-block-h: ${CELL_BLOCK_H_PX}px; --cell-hit-w: ${CELL_HIT_W_PX}px; --cell-hit-h: ${CELL_HIT_H_PX}px; } /* AD6: items STRETCH (was align-items:start) so short columns keep their sticky headers bounded to full row height. AD7: the row PITCH lives here as the single source — AD11: pitch = box(--cell-mini)+gutter(--cell-gutter). AD12: the gutter is a FIXED constant (owner knob); --cell-pitch is the DERIVED rhythm, served for the chain — no independent value literals in the rules (L220). */
  .col h2 { font-size: 12px; margin: 0 0 6px; color: var(--dim); border-bottom: 1px solid var(--line); padding: 6px 0 4px; position: sticky; top: 44px; z-index: 5; background: var(--bg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } /* AD6: pins directly under the 44px livebar (test-pinned constant). AD10: labels ALWAYS exceed the narrow track — honest ellipsis, the full title rides the h2 title attribute (developer ruling 4). */
  /* AD10 trace mode (supersedes the AD7/AD9 mini-box visuals): a .cell is a
     TRANSPARENT row-pitch box — zero content, zero paint. The visible block is a
     ::after rounded rect painted from the per-column lane color (set once per
     column at buildGrid; theme rides the [data-theme] cascade below). Hover/click
     comfort is the ::before hit-area pseudo; the box itself takes no pointer
     events, so comfort never means "the whole row is clickable". Height stays
     var(--cell-mini): the AD7 1:1 row spine is unchanged — AD11 only NARROWED the
     pitch (box=14, gutter=→ token; vertical hit = pitch, adjacent hit rects touch,
     never overlap). Zero px literals in these rules (L220). */
  .cell { position: relative; cursor: pointer; pointer-events: none; height: var(--cell-mini, 14px); margin-bottom: var(--cell-gutter, 4px); }
  .cell::before { content: ""; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: var(--cell-hit-w, 44px); height: var(--cell-hit-h, var(--cell-pitch)); pointer-events: auto; } /* the interactive extension — height CONSUMES the pitch chain (AD12: hit ≡ pitch ⇒ adjacent hit rects gap 0, never overlap); events retarget to the cell (DOM-zero) */
  .cell::after { content: ""; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: var(--cell-block-w, 24px); height: var(--cell-block-h, 14px); border-radius: 4px; background: var(--block-light, var(--dim)); } /* the arkanoid block: solid, rounded, centered, zero content */
  [data-theme="dark"] .cell::after { background: var(--block-dark, var(--block-light, var(--dim))); } /* theme flip = the existing [data-theme] token path ONLY — no JS recolor path exists */
  .slot { height: var(--cell-mini, 14px); margin-bottom: var(--cell-gutter, 4px); } /* invisible row-keeper: same pitch, zero chrome — the 1:1 alignment survives at the new rhythm */
  /* AD8 — payload tree + mode switch. ALL colors are theme tokens (both themes, no literals). */
  .payload-bar { display: flex; gap: 6px; align-items: center; margin: 6px 0; }
  .pmode { font: inherit; font-size: 12px; background: var(--badge); color: var(--dim); border: 1px solid var(--line); border-radius: 6px; padding: 2px 10px; cursor: pointer; }
  .pmode.on { color: var(--bg); background: var(--accent); border-color: var(--accent); }
  .pmode:disabled { opacity: 0.45; cursor: not-allowed; }
  .ptool { font: inherit; font-size: 12px; background: none; color: var(--dim); border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .payload-hint { color: var(--dim); font-size: 12px; margin: 2px 0 6px; }
  .jt_row { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .jt_tw { background: none; border: none; color: var(--dim); cursor: pointer; font: inherit; padding: 0 4px; }
  .jt_key { color: var(--accent); }
  .jt_string { color: var(--live-on); }
  .jt_number { color: var(--warn); }
  .jt_boolean { color: var(--accent); }
  .jt_null { color: var(--dim); }
  .jt_count { color: var(--dim); }
  .jt_punct { color: var(--dim); }
  .jt_children { padding-left: 14px; border-left: 1px solid var(--line); }
   /* AD9: the column-hover magnification rule and the cell preview rule were
      DELETED here — superseded by the floating hover card below (text in ONE
      place, ever). Kept this note selector-free on purpose (grep-probe). */
   /* (AD10) The ts-text rule, the state dots, the truncation dot and the
      unattributed dashed-border variant were ALL deleted here: cells carry zero
      content and zero paint, so in-cell marking cannot exist. Truncation and
      attribution states were never cell-only anyway — they stay stated in full
      in the hover card and the drawer, which are unchanged surfaces.
      Selector-free notes, same grep-clean discipline. */
  /* AD9 — ONE reused floating hover card (floating-ui FEEL, hand-rolled): fixed +
     measured (never absolute-in-scroller: no clipping, AD6 pinning unaffected).
     z 40 = above column headers (5) and livebar (6); #drawer carries z 60 ABOVE
     this card. pointer-events:none → the card never blocks hover or click. */
  #hovercard { position: fixed; left: 0; top: 0; z-index: 40; pointer-events: none; visibility: hidden; min-width: 240px; max-width: 340px; background: var(--tooltip); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  #hovercard.show { visibility: visible; }
  #hovercard .hc-ts { color: var(--dim); font: 11px ui-monospace, monospace; }
  #hovercard .hc-cat { color: var(--ink); font-weight: 600; margin-top: 2px; }
  #hovercard .hc-src { color: var(--dim); font-size: 12px; margin-top: 2px; }
  #hovercard .hc-prev { color: var(--ink); white-space: pre-wrap; word-break: break-word; margin-top: 6px; }
  #hovercard .hc-absent { color: var(--warn); margin-top: 2px; }
  #drawer { width: 0; flex: none; overflow: hidden; transition: width 120ms; max-height: calc(100vh - 44px); position: relative; z-index: 60; } /* AD7: border-left removed by owner instruction — the AD5 divider (#drawerresizer) is the seam now. AD9: explicit z above the hover card (40) — card is ALWAYS fully under the drawer. */
  #drawer .dclose { position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; background: var(--badge); color: var(--accent); border: 1px solid var(--line); border-radius: 6px; cursor: pointer; padding: 0; }
  #drawer .dclose svg { width: 14px; height: 14px; }
  /* AD5 divider (persona-graph #dragbar idiom): 7px col-resize bar hugging the
     drawer's left edge; visible ONLY while the drawer is open (.show toggled by
     openDrawer/closeDrawer, so AD4 close/Esc hide it too). Stylesheet is plain
     CSS: slash-slash comments are illegal here and silently kill the rules that
     follow them — caught live in the AD5 battery, do not reintroduce. */
  #drawerresizer { display: none; width: 7px; flex: none; cursor: col-resize; background: transparent; border-left: 2px solid var(--line); }
  #drawerresizer.show { display: block; }
  #drawerresizer:hover, #drawerresizer:active { border-left-color: var(--accent); }
  #drawer.open { width: min(var(--drawer), calc(100vw - var(--sidebar-w, 280px) - 23px - var(--stage-min, 24px))); max-width: 92vw; padding: 12px; overflow-y: auto; } /* AD5: reserve = 14 gutter + 9 divider box (=23) + 24 stage-min; composition mirrored by clampDrawerWidth (DRAWER_FIT_RESERVE=47) */
  #drawer h2 { font-size: 13px; margin: 0 0 8px; }
  #drawer table { border-collapse: collapse; width: 100%; font-size: 11px; margin-bottom: 10px; }
  #drawer td { border: 1px solid var(--line); padding: 3px 6px; vertical-align: top; word-break: break-word; }
  #drawer pre { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px; white-space: pre-wrap; word-break: break-word; font-size: 11px; }
  #drawer .note { color: var(--warn); margin-bottom: 8px; font-size: 11px; }
  #drawer button { margin: 2px 4px 2px 0; background: var(--badge); color: var(--accent); border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; cursor: pointer; }
  #livebar { position: sticky; top: 0; z-index: 6; height: 44px; background: var(--bg); white-space: nowrap; margin: 0 -12px; padding: 0 12px; display: flex; gap: 8px; align-items: center; border-bottom: 1px solid var(--line); } /* AD6: stage's pinned head; 44px matches .col h2 top AND the shell's header height constant (both test-pinned) */
  #live.on { color: var(--live-on); font-weight: 600; }
  #live.off { color: var(--dim); }
  #livebtn { background: var(--badge); color: var(--accent); border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; cursor: pointer; }
  #empty { color: var(--dim); padding: 30px; }
</style>
</head>
<body>
<header data-testid="si-header"><h1>Session Inspector</h1><span id="status"></span><button id="themeToggle" data-testid="si-theme-toggle" type="button" aria-label="toggle light/dark theme"><svg class="i-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><svg class="i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor"/></svg></button></header>
<main>
  <aside id="sidebar" data-testid="si-sidebar">
    <div id="filterdock" data-testid="si-filter-dock"><input id="filter" data-testid="si-filter" type="search" placeholder="filter sessions (server-side LIKE)"></div>
    <div id="sessions" data-testid="si-session-list"></div>
  </aside>
  <div id="resizer" data-testid="si-resizer" role="separator" aria-orientation="vertical" aria-label="resize sidebar"></div>
  <section id="stage" data-testid="si-stage"><div id="livebar" data-testid="si-livebar"><span id="live" class="off" data-testid="si-live-status">idle</span><button id="livebtn" data-testid="si-live-toggle">pause</button></div><div id="grid" data-testid="si-grid"></div><div id="empty" data-testid="si-empty">pick a session on the left - timeline streams in</div></section>
  <div id="drawerresizer" data-testid="si-drawer-resizer" title="drag to resize drawer"></div>
  <div id="hovercard" role="tooltip" aria-hidden="true" data-testid="si-hover-card"><span class="hc-ts" data-testid="si-hover-card-ts"></span><div class="hc-cat" data-testid="si-hover-card-cat"></div><div class="hc-src" data-testid="si-hover-card-src"></div><div class="hc-prev" data-testid="si-hover-card-preview"></div></div>
  <aside id="drawer" data-testid="si-drawer"></aside>
</main>
<script>
"use strict";
// -- tiny hyperscript helper (the only "framework") ---------------------------
function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (k === "text") el.textContent = attrs[k];
    else if (k === "html") el.innerHTML = attrs[k];
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), attrs[k]);
    else el.setAttribute(k, attrs[k]);
  }
  for (var i = 2; i < arguments.length; i++) {
    addKids(el, arguments[i]);
  }
  return el;
}
// nested child arrays are flattened (badges strips pass badges.slice(1) as an array;
// appendChild(array) would THROW and the stream-loop catch would silently drop the row)
function addKids(el, kid) {
  if (kid == null) return;
  if (Array.isArray(kid)) { for (var j = 0; j < kid.length; j++) addKids(el, kid[j]); return; }
  el.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
}
var $ = function (id) { return document.getElementById(id); };
var current = null; // {id,title}
var streamAbort = null;
var liveEs = null;      // EventSource for the live tail (Task 6)
var livePaused = false; // pause stops appends instantly by closing the stream

function fmtTime(epochOrIso) {
  try {
    var d = typeof epochOrIso === "number" ? new Date(epochOrIso) : new Date(epochOrIso);
    if (isNaN(d)) return String(epochOrIso);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  } catch (e) { return String(epochOrIso); }
}

// -- config drives EVERYTHING about the grid (SC-2) ----------------------------
var cfg = null;
async function loadConfig() {
  var res = await fetch("/session-inspector/config");
  cfg = await res.json();
  if (cfg.configWarning) status("warning: " + cfg.configWarning.code);
}
function columns() {
  return cfg.categories.filter(function (c) { return c.enabled; }).sort(function (a, b) { return a.order - b.order; });
}

// -- sidebar: session feed + server-side LIKE while typing + folder-only scan --
var feedRows = [];
var folderOnly = [];
async function loadSessions(q) {
  var url = "/session-inspector/sessions?limit=100" + (q ? "&q=" + encodeURIComponent(q) : "");
  var res = await fetch(url);
  feedRows = await res.json();
  renderSidebar();
}
async function loadScanExtra() {
  try {
    var res = await fetch("/session-inspector/sessions/scan");
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    var count = 0;
    while (count < 25) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var lines = buf.split("\n");
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        var rec = JSON.parse(lines[i]);
        folderOnly.push(rec);
        count++;
        if (count >= 25) break;
      }
    }
    renderSidebar();
  } catch (e) { /* scan is additive; absence degrades the flag list only */ }
}
function renderSidebar() {
  var box = $("sessions");
  box.textContent = "";
  var ids = {};
  feedRows.forEach(function (r) { ids[r.id] = true; });
  // group: roots then children (indent-tree via parent_id)
  var roots = feedRows.filter(function (r) { return !r.parent_id || !ids[r.parent_id]; });
  var kids = {};
  feedRows.forEach(function (r) { if (r.parent_id && ids[r.parent_id]) (kids[r.parent_id] = kids[r.parent_id] || []).push(r); });
  function addRow(r, isChild) {
    var r2 = h("div", { class: "r2" }, (r.agent || "?"), h("span", { text: fmtTime(r.time_updated || r.time_created) }));
    var row = h("div", { class: "row" + (isChild ? " child" : "") + (current && current.id === r.id ? " selected" : ""), "data-sid": r.id, "data-testid": siRowTestId(r.id), onclick: function () { selectSession(r.id, r.title); } },
      h("div", { class: "r1", text: r.title || r.id }), r2);
    box.appendChild(row);
    (kids[r.id] || []).forEach(function (k) { addRow(k, true); });
  }
  roots.forEach(function (r) { addRow(r, false); });
  folderOnly.forEach(function (rec) {
    if (ids[rec.sessionId]) return;
    box.appendChild(h("div", { class: "row", "data-sid": rec.sessionId, "data-testid": siRowTestId(rec.sessionId), onclick: function () { selectSession(rec.sessionId, rec.title || rec.sessionId); } },
      h("div", { class: "r1", text: rec.title || rec.sessionId }),
      h("div", { class: "r2" }, rec.sessionId, h("span", { class: "tag folder", text: "folder-only" }))));
  });
  // AD3 absent-state marker (only when the list is genuinely empty — no rows at all)
  if (!box.childElementCount) box.appendChild(h("div", { "data-testid": "si-sessions-empty", text: "no sessions matched" }));
}

// -- grid + incremental NDJSON appends ----------------------------------------
var colById = {};
// AD7 row spine: rowSlots is the GLOBAL vertical order (one entry per rendered
// row, 1:1 with accepted envelopes); EVERY column carries an aligned child per
// row (its cell, or a .slot keeper) so vertical position is monotonic in ts
// across columns. rankById maps category -> config column index (tie-order rank).
var rowSlots = [], rankById = {};
function buildGrid() {
  var grid = $("grid");
  grid.textContent = "";
  colById = {};
  rowSlots = []; rankById = {}; // AD7: both structures reset together with the columns
  var hh = (cfg.cell && cfg.cell.height) || 120;
  // AD10 (supersedes AD2 stretch): fixed narrow left-aligned tracks; config still
  // decides the COUNT and ORDER (columns()) — the track template is the single core.
  grid.style.gridTemplateColumns = gridTrackTemplate(columns().length);
  columns().forEach(function (c, ci) {
    var col = h("div", { class: "col", "data-cat": c.id, "data-testid": siColTestId(c.id) }, h("h2", { "data-testid": siColHeaderTestId(c.id), "title": c.title, text: c.title }));
    col.style.minHeight = "60px";
    col.dataset.cellHeight = String(hh); // config cell height stays observable on the column (AD2 surface)
    // AD10: the column's block color — both theme steps computed ONCE from the
    // pure core and carried as vars; the [data-theme] cascade picks the step on
    // flip (no repaint path exists). Renamed/unknown lanes resolve deterministically.
    col.style.setProperty("--block-light", laneBlockColor(c.id, "light"));
    col.style.setProperty("--block-dark", laneBlockColor(c.id, "dark"));
    rankById[c.id] = ci; // config column order = documented tie-order rank
    colById[c.id] = col;
    grid.appendChild(col);
  });
}
var shown = 0, hiddenByConfig = 0, dropped = 0;
function appendCell(env) {
  var col = colById[env.category];
  if (!col) { hiddenByConfig++; status(current.id + ": " + shown + " rows" + (hiddenByConfig ? " (" + hiddenByConfig + " rows hidden: column removed from config)" : "")); return; }
  var sr = env.sourceRef || {};
  var seq = Number(col._cellSeq || 0); // AD3 per-column monotonic seq (naming only)
  col._cellSeq = seq + 1;
  // AD7: ONE row per data point, positioned by the injected pure core —
  // never by per-column stacking counters. All columns get a child at the
  // SAME index (cell for the owner, .slot filler for the others).
  var key = { ts: env.ts, colRank: rankById[env.category], seq: seq };
  var idx = rowInsert(rowSlots, key); rowSlots.splice(idx, 0, key);
  var cell = h("div", { class: "cell", "data-category": env.category, "data-testid": siCellTestId(env.category, seq), "data-db": sr.dbId || "", "data-ts": env.ts, "aria-label": env.ts, onclick: function () { hideHoverCard(); openDrawer(env); } });
  cell._rk = key;
  cell._env = env; // AD9: the ONE reused hover card renders from this ref (no global lookup)
  // AD10 (supersedes the AD9 ts-text + dots build): the cell carries ZERO content —
  // no text nodes, no child elements, no markers. ts and lane live ONLY in the
  // attributes above (data-ts / data-category / aria-label = ts for a11y); the
  // visible block and the hit comfort are the ::after / ::before pseudos (pure
  // CSS from the injected vars). Full detail remains exactly two surfaces: the
  // hover card (unchanged) on hover and the drawer (unchanged) on click.
  // AD7 placement: same row index in EVERY column (header occupies child 0).
  var colsAll = $("grid").children;
  for (var ci = 0; ci < colsAll.length; ci++) {
    var node = ci === key.colRank ? cell : h("div", { class: "slot", "data-ts": env.ts });
    colsAll[ci].insertBefore(node, colsAll[ci].children[idx + 1] || null);
  }
  shown++;
  // (AD10) the rAF clip-dot block was removed WITH the clip rule: a zero-content
  // block cannot show an in-cell truncation dot; server-side truncation and the
  // card's own cap note stay stated where they always were (hover card + drawer).
  status(current.id + ": " + shown + " rows" + (hiddenByConfig ? " (" + hiddenByConfig + " rows hidden: column removed from config)" : ""));
}
// ONE line parser for BOTH transports (Task 6 contract): the pushed SSE frames carry
// byte-identical envelope lines to the NDJSON timeline stream, so the client parses
// lines in exactly one place - a second parser could drift from the ratified shape.
function parseLine(s) { return JSON.parse(s); }
async function selectSession(id, title) {
  current = { id: id, title: title || id };
  var stage = $("stage"); stage.scrollTop = 0; stage.scrollLeft = 0; // AD6: session switch = new document top; the sidebar's own scroll is deliberately untouched
  renderSidebar();
  buildGrid();
  shown = 0; hiddenByConfig = 0; dropped = 0;
  $("empty").style.display = "none";
  if (streamAbort) streamAbort.abort();
  streamAbort = new AbortController();
  subscribeLive(id); // reload mid-stream = full rebuild (timeline) + fresh subscribe
  try {
    var res = await fetch("/session-inspector/session/" + encodeURIComponent(id) + "/timeline", { signal: streamAbort.signal });
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var lines = buf.split("\n");
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        try { appendCell(parseLine(lines[i])); }
        catch (e) {
          // malformed line OR a render defect: count it in the status, never silent
          dropped++;
          status(current.id + ": " + shown + " rows" + (dropped ? " (" + dropped + " rows dropped: " + (e && e.message ? e.message : String(e)) + ")" : ""));
        }
      }
    }
  } catch (e) {
    if (e && e.name !== "AbortError") status("stream error: " + e.message);
  }
}

// -- live tail (Task 6): bus -> SSE -> incremental appends, pause/resume ------
// The server pushes the SAME envelope line bytes the NDJSON timeline uses
// (liveSseFrameBody pins that), so this handler feeds frames through parseLine -
// the one line parser - and appends/removes cells; it never refetches anything.
function setLive(on) {
  var el = $("live");
  el.textContent = on ? "LIVE" : (livePaused ? "PAUSED" : "off");
  el.className = on ? "on" : "off";
  $("livebtn").textContent = livePaused ? "resume" : "pause";
}
function subscribeLive(id) {
  if (liveEs) { liveEs.close(); liveEs = null; }
  if (livePaused) { setLive(false); return; } // paused = no reconnect while paused
  liveEs = new EventSource("/session-inspector/session/" + encodeURIComponent(id) + "/live");
  liveEs.onopen = function () { setLive(true); };
  liveEs.onerror = function () { setLive(false); }; // strip reflects the transport state
  liveEs.onmessage = function (ev) {
    try {
      var env = parseLine(ev.data);
      var sr = env.sourceRef || {};
      if (sr.removed && sr.dbId) {
        var cell = document.querySelector('[data-db="' + sr.dbId + '"]');
        if (cell) {
          // AD7: remove the WHOLE row — identity join through the row key.
          var rIdx = cell._rk ? rowSlots.indexOf(cell._rk) : -1;
          if (rIdx > -1) {
            rowSlots.splice(rowSlots.indexOf(cell._rk), 1);
            var colsRm = $("grid").children;
            for (var ri = 0; ri < colsRm.length; ri++) { var kid = colsRm[ri].children[rIdx + 1]; if (kid) colsRm[ri].removeChild(kid); }
          } else if (cell.parentNode) {
            cell.parentNode.removeChild(cell); // defensive: untracked cell removes alone
          }
          if (shown > 0) shown--;
        }
        status(current.id + ": " + shown + " rows (part removed by bus event)");
        return;
      }
      appendCell(env);
    } catch (e) {
      dropped++;
      status(current.id + ": " + shown + " rows" + (dropped ? " (" + dropped + " frames dropped: " + (e && e.message ? e.message : String(e)) + ")" : ""));
    }
  };
}
$("livebtn").addEventListener("click", function () {
  livePaused = !livePaused;
  if (livePaused) {
    if (liveEs) { liveEs.close(); liveEs = null; } // pause stops appends INSTANTLY
  } else if (current) {
    subscribeLive(current.id); // resume reconnects where SSE picks up
  }
  setLive(false);
});

// -- drawer: ratified payload grammar + explicit absence + cross-links ---------
function refQuery(ref) {
  if (ref.kind === "dbId") return "kind=dbId&dbId=" + encodeURIComponent(ref.dbId);
  if (ref.kind === "historyLine") return "kind=historyLine&line=" + ref.line + "&file=" + encodeURIComponent(ref.file || "history.jsonl");
  if (ref.kind === "logLine") return "kind=logLine&callId=" + encodeURIComponent(ref.callId);
  return null;
}
async function fetchPayload(ref) {
  var q = refQuery(ref);
  if (!q) return null;
  var res = await fetch("/session-inspector/session/" + encodeURIComponent(current.id) + "/payload?" + q);
  return await res.json();
}
function jsonBlock(v) {
  return h("pre", { "data-testid": "si-drawer-payload", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) });
}
// AD8 — payload modes. Choice persists for the PAGE LOAD via module state (explicit
// choice; NO new storage keys). Raw mode delegates to jsonBlock UNCHANGED (byte-
// identical rendering); tree mode renders model nodes via textContent only (XSS
// discipline — payload data never touches innerHTML).
var payloadMode = "tree";
function payloadTextOf(p) { return typeof p === "string" ? p : JSON.stringify(p, null, 2); }
function renderPayloadSection(sec, body) {
  sec.textContent = "";
  var payloadText = payloadTextOf(body.payload); // ONE text value feeds both modes
  var model = jsonTreeModel(payloadText);
  var forcedRaw = body.truncated === true || model.ok !== true || model.overBudget === true;
  var bar = h("div", { class: "payload-bar" });
  var treeBtn = h("button", { type: "button", class: "pmode", "data-testid": "si-payload-mode-tree", text: "tree", onclick: function () { payloadMode = "tree"; renderPayloadSection(sec, body); } });
  var rawBtn = h("button", { type: "button", class: "pmode", "data-testid": "si-payload-mode-raw", text: "raw", onclick: function () { payloadMode = "raw"; renderPayloadSection(sec, body); } });
  if (payloadMode === "tree" && !forcedRaw) treeBtn.classList.add("on");
  if (payloadMode === "raw") rawBtn.classList.add("on");
  if (forcedRaw) treeBtn.setAttribute("disabled", "");
  bar.appendChild(treeBtn); bar.appendChild(rawBtn);
  var showingTree = payloadMode === "tree" && !forcedRaw;
  if (showingTree) {
    bar.appendChild(h("button", { type: "button", class: "ptool", "data-testid": "si-payload-expand-all", text: "expand all", onclick: function () { treeState = treeStateReducer(treeState, { type: "expand-all" }); paintTree(); } }));
    bar.appendChild(h("button", { type: "button", class: "ptool", "data-testid": "si-payload-collapse-all", text: "collapse all", onclick: function () { treeState = treeStateReducer(treeState, { type: "collapse-all" }); paintTree(); } }));
  }
  sec.appendChild(bar);
  if (forcedRaw && payloadMode === "tree") {
    sec.appendChild(h("div", { class: "payload-hint", "data-testid": "si-payload-fallback-note", text: body.truncated === true ? "not valid JSON (payload truncated at cap) — raw view shown, full raw text below" : model.ok !== true ? "not valid JSON — raw view shown" : "too many nodes for the tree view (over " + TREE_NODE_BUDGET + ") — raw view shown, complete" }));
  }
  if (showingTree) {
    treeRoot = model.root;
    treeState = initialTreeState(model.root); // fresh open: root expanded to default depth
    treeHost = h("div", { class: "jt_children" });
    sec.appendChild(treeHost);
    paintTree();
  } else {
    sec.appendChild(jsonBlock(body.payload)); // raw: existing rendering, unchanged
  }
}
var treeRoot = null, treeState = null, treeHost = null;
function paintTree() {
  if (!treeHost) return;
  treeHost.textContent = ""; // rebuild from state (data volume is capped by TREE_NODE_BUDGET)
  treeHost.appendChild(buildTreeRow(treeRoot));
}
function buildTreeRow(node) {
  var row = h("div", { class: "jt_row", "data-path": node.path });
  var isContainer = node.kind === "object" || node.kind === "array";
  var open = isContainer && treeState.expanded.indexOf(node.path) !== -1;
  if (isContainer) {
    row.appendChild(h("button", { type: "button", class: "jt_tw", "aria-expanded": open ? "true" : "false", "aria-label": "toggle node", text: open ? "▾" : "▸", onclick: function () { treeState = treeStateReducer(treeState, { type: "toggle-node", path: node.path }); paintTree(); } }));
  }
  if (node.key !== null && node.key !== undefined) row.appendChild(h("span", { class: "jt_key", text: JSON.stringify(node.key) }));
  if (isContainer) {
    row.appendChild(h("span", { class: "jt_punct", text: node.kind === "array" ? " [" : " {" }));
    row.appendChild(h("span", { class: "jt_count", text: "{" + node.count + "}" }));
    if (open) {
      var kids = h("div", { class: "jt_children" });
      for (const c of node.children) kids.appendChild(buildTreeRow(c));
      row.appendChild(kids);
      row.appendChild(h("span", { class: "jt_punct", text: node.kind === "array" ? " ]" : " }" }));
    } else {
      row.appendChild(h("span", { class: "jt_punct", text: " …" }));
    }
  } else {
    row.appendChild(h("span", { class: "jt_" + node.kind, text: node.kind === "string" ? JSON.stringify(node.value) : String(node.value) }));
  }
  return row;
}
function closeDrawer() {
  $("drawer").classList.remove("open"); $("drawerresizer").classList.remove("show"); // state-light: grid/selection/scroll untouched; AD5 divider hides with it
}
// AD4: document-level Esc (semantic core is unit-pinned; additive, no re-render).
document.addEventListener("keydown", function (ev) {
  if (escShouldCloseDrawer(ev.key, $("drawer").classList.contains("open"))) closeDrawer();
});
async function openDrawer(env) {
  var d = $("drawer");
  d.classList.add("open");
  $("drawerresizer").classList.add("show"); // AD5: divider visible only while open
  d.textContent = "";
  // AD4 close control: icon-only (AD1 idiom), AD3 testid, top-right via .dclose rule.
  d.appendChild(h("button", { class: "dclose", "data-testid": "si-drawer-close", type: "button", "aria-label": "close drawer", onclick: closeDrawer, html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' }));
  d.appendChild(h("h2", { text: "cell · " + env.category }));
  var meta = h("table", { "data-testid": "si-drawer-meta" });
  function mrow(k, v) { meta.appendChild(h("tr", null, h("td", { text: k }), h("td", { text: String(v) }))); }
  mrow("category", env.category); mrow("ts", env.ts);
  var sr = env.sourceRef || {};
  Object.keys(sr).forEach(function (k) { mrow("sourceRef." + k, sr[k]); });
  d.appendChild(meta);
  if (env.payloadRef && env.payloadRef.truncated === true) {
    d.appendChild(h("div", { class: "note", "data-testid": "si-drawer-note", text: "payload exceeds configured cap - shown truncated at the reference level; fullLength: " + env.payloadRef.fullLength + " bytes" }));
  }
  var body = await fetchPayload(env.payloadRef);
  if (!body) { d.appendChild(h("div", { class: "note", "data-testid": "si-drawer-note", text: "no payloadRef on this row" })); return; }
  if (body.sourceAbsent) {
    d.appendChild(h("div", { class: "note", "data-testid": "si-drawer-source-absent", text: "source absent: " + body.sourceAbsent.reason + (body.sourceAbsent.file ? " (" + body.sourceAbsent.file + ")" : "") }));
    return;
  }
  if (body.truncated)     d.appendChild(h("div", { class: "note", "data-testid": "si-drawer-note", text: "truncated at cap - fullLength " + body.fullLength + " bytes" }));
  d.appendChild(h("h2", { text: "payload (" + body.kind + ")" }));
  // AD8: mode-bar + tree/raw section (raw path = jsonBlock unchanged; tree only for
  // parseable, non-truncated, in-budget payloads — otherwise forced raw + hint).
  var psec = h("div", { class: "payload-sec" });
  d.appendChild(psec);
  renderPayloadSection(psec, body);
  // cross-links ONLY where refs actually exist
  var links = [];
  if (sr.ref_part_id) links.push(h("button", { onclick: function () { openDrawer({ category: "linked", ts: env.ts, sourceRef: { kind: "dbId", dbId: sr.ref_part_id }, payloadRef: { kind: "dbId", dbId: sr.ref_part_id } }); }, text: "→ part " + sr.ref_part_id }));
  var pl = body.payload;
  var toolCallId = null;
  if (typeof pl === "string") { try { pl = JSON.parse(body.payload); } catch (e) { pl = null; } }
  if (pl && typeof pl === "object" && pl.type === "tool" && pl.callID) toolCallId = pl.callID;
  // cap-truncated string payload cannot JSON.parse; the callID ref lives in the prefix
  if (toolCallId === null && typeof body.payload === "string" && body.payload.includes("\"type\":\"tool\"")) {
    var m = /"callID":"([^"]+)"/.exec(body.payload);
    if (m) toolCallId = m[1];
  }
  if (toolCallId !== null) {
    links.push(h("button", { onclick: function () { showLogLine(toolCallId); }, text: "⇄ tools.log " + toolCallId }));
  }
  if (sr.kind === "historyLine") {
    links.push(h("button", { onclick: function () { showLogLineFromHistory(env); }, text: "⇄ tools.log (by callID in payload)" }));
  }
  if (links.length) d.appendChild(h("div", null, links));
}
async function showLogLine(callId) {
  var body = await fetchPayload({ kind: "logLine", callId: callId });
  var d = $("drawer");
  d.appendChild(h("h2", { text: "tools.log line " + callId }));
  if (!body) return;
  if (body.sourceAbsent) { d.appendChild(h("div", { class: "note", text: "tools.log line absent: " + body.sourceAbsent.reason + " - enrichment degraded only, DB state above stands" })); return; }
  // AD8: the debug line goes through the SAME payload section discipline — raw log
  // text forces raw view honestly with the controls present-disabled; JSON lines tree.
  var lsec = h("div", { class: "payload-sec" });
  d.appendChild(lsec);
  renderPayloadSection(lsec, body);
}
function showLogLineFromHistory(env) {
  // history lines carry no callID: open the payload we have and say so explicitly
  var d = $("drawer");
  d.appendChild(h("div", { class: "note", text: "this source is a history line - no tools.log reference exists for it (none shown)" }));
}
function status(msg) { $("status").textContent = msg || ""; }

// ── AD9 — floating hover card (supersedes the AD7 dock magnifier) ──────────
// ONE reused fixed-position card (role=tooltip, pointer-events:none): 150 ms
// cancellable intent delay, delegated pointerover/out on the grid (re-renders and
// .slot neighbors unaffected), hides on leave, on any scroll (capture = every
// scroller; stated choice: hide, no reposition-thrash tracking) and before the
// drawer opens (its onclick). Placement + preview cap ride the injected pure
// cores — this block only measures and assigns.
var hoverTimer = null, hoverCard = null, hoverFor = null;
function showHoverFor() {
  hoverTimer = null;
  if (!hoverFor || !hoverFor._env) return;
  if (!hoverCard) hoverCard = $("hovercard");
  var env = hoverFor._env, sr = env.sourceRef || {};
  var parts = [];
  if (sr.kind) parts.push("source: " + sr.kind);
  if (sr.bankAuthoritative) parts.push("bank (authoritative)");
  else if (sr.attributed === false) parts.push("UNATTRIBUTED");
  if (sr.lineage) parts.push(sr.lineage === "db-parent" ? "db-sub" : "history-sub");
  hoverCard.children[0].textContent = env.ts || "";
  hoverCard.children[1].textContent = env.category || "";
  hoverCard.children[2].textContent = parts.length ? parts.join(" · ") : "source: unknown";
  var pv = hoverPreviewText(env.summary);
  hoverCard.children[3].textContent = pv.text.length ? pv.text + (pv.capped ? " [truncated in card - drawer shows full]" : "") : "no preview text available for this row - full payload (or its honest absence) opens with the click";
  if (pv.text.length === 0) hoverCard.children[3].className = "hc-absent";
  else hoverCard.children[3].className = "hc-prev";
  var p = computePopoverPlacement(hoverFor.getBoundingClientRect(), { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }, hoverCard.getBoundingClientRect());
  hoverCard.style.left = Math.round(p.x) + "px";
  hoverCard.style.top = Math.round(p.y) + "px";
  hoverCard.classList.add("show");
  hoverCard.setAttribute("aria-hidden", "false");
}
function hideHoverCard() {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  hoverFor = null;
  if (hoverCard) { hoverCard.classList.remove("show"); hoverCard.setAttribute("aria-hidden", "true"); }
}
$("grid").addEventListener("pointerover", function (ev) {
  var cell = ev.target && ev.target.closest ? ev.target.closest(".cell") : null;
  if (!cell || cell === hoverFor) return;
  hoverFor = cell;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(showHoverFor, POPOVER_INTENT_MS);
});
$("grid").addEventListener("pointerout", function (ev) {
  var to = ev.relatedTarget && ev.relatedTarget.closest ? ev.relatedTarget.closest(".cell") : null;
  if (to && to === hoverFor) return; // moving within the SAME cell: keep intent
  hideHoverCard();
});
window.addEventListener("scroll", hideHoverCard, true); // capture=true: hides on ANY scroller (stated choice)

// ── AD-UI controls (owner 2026-11-04): drag-resize sidebar + icon-only theme ──
// The clamp/codec constants+functions are INJECTED from ui.ts (single source;
// ui.test.ts pins them directly), so browser math and unit tests can never drift.
var SIDEBAR_MIN_WIDTH = ${SIDEBAR_MIN_WIDTH};
var SIDEBAR_MAX_WIDTH = ${SIDEBAR_MAX_WIDTH};
var SIDEBAR_DEFAULT_WIDTH = ${SIDEBAR_DEFAULT_WIDTH};
var SIDEBAR_WIDTH_KEY = "${SIDEBAR_WIDTH_KEY}";
var THEME_CHOICE_KEY = "${THEME_CHOICE_KEY}";
${clampSidebarWidth.toString()}
${decodeStoredWidth.toString()}

// AD2→AD10 track core (same injection discipline as AD1: browser and unit tests
// can never drift — the served track template IS the tested function).
var GRID_TRACK_PX = ${GRID_TRACK_PX};
${gridTrackTemplate.toString()}

// AD10 lane colors: the tested pure core and its vendored data, injected once.
// (CSS custom properties for the per-column steps are set in buildGrid; the
// block/hit metric vars are declared on #grid from the module constants above.)
var LANE_BLOCK_BASE = ${JSON.stringify(LANE_BLOCK_BASE)};
var LANE_BLOCK_OVERFLOW = ${JSON.stringify(LANE_BLOCK_OVERFLOW)};
${laneBlockColor.toString()}

// AD3 testid cores (same single-source injection; naming only — zero behavior).
${siRowTestId.toString()}
${siColTestId.toString()}
${siColHeaderTestId.toString()}
${siCellTestId.toString()}
${rowInsert.toString()}
var TREE_NODE_BUDGET = ${TREE_NODE_BUDGET};
var TREE_DEFAULT_EXPAND_DEPTH = ${TREE_DEFAULT_EXPAND_DEPTH};
${jsonTreeModel.toString()}
${initialTreeState.toString()}
${treeStateReducer.toString()}
var POPOVER_GAP_PX = ${POPOVER_GAP_PX};
var POPOVER_EDGE_MARGIN_PX = ${POPOVER_EDGE_MARGIN_PX};
var POPOVER_INTENT_MS = ${POPOVER_INTENT_MS};
var POPOVER_PREVIEW_CAP = ${POPOVER_PREVIEW_CAP};
${computePopoverPlacement.toString()}
${hoverPreviewText.toString()}
${escShouldCloseDrawer.toString()}

// AD5 drawer-resize cores (single source). Width rides the --drawer CSS var so
// AD2's open-clamp composes with it; closed state is untouched (var only affects
// the .open rule).
var DRAWER_MIN_WIDTH = ${DRAWER_MIN_WIDTH};
var DRAWER_MAX_WIDTH = ${DRAWER_MAX_WIDTH};
var DRAWER_DEFAULT_WIDTH = ${DRAWER_DEFAULT_WIDTH};
var DRAWER_VIEWPORT_GUTTER = ${DRAWER_VIEWPORT_GUTTER};
var DRAWER_DIVIDER_BOX = ${DRAWER_DIVIDER_BOX};
var DRAWER_STAGE_MIN = ${DRAWER_STAGE_MIN};
var DRAWER_FIT_RESERVE = ${DRAWER_FIT_RESERVE};
var DRAWER_WIDTH_KEY = "${DRAWER_WIDTH_KEY}";
${clampDrawerWidth.toString()}
${decodeStoredDrawerWidth.toString()}

// AD5 drag block — pointer-capture idiom shared with the AD1 sidebar resizer
// (deliberately parallel, zero layout machinery beyond setting --drawer).
(function () {
  var rz = $("drawerresizer");
  function applyDrawerWidth(w) { document.documentElement.style.setProperty("--drawer", w + "px"); }
  function sidebarNow() { return parseFloat(getComputedStyle($("sidebar")).width) || ${SIDEBAR_DEFAULT_WIDTH}; }
  var saved = decodeStoredDrawerWidth(localStorage.getItem(DRAWER_WIDTH_KEY));
  applyDrawerWidth(clampDrawerWidth(saved === null ? DRAWER_DEFAULT_WIDTH : saved, innerWidth, sidebarNow()));
  var dragging = false, startX = 0, wNow = 0;
  rz.addEventListener("pointerdown", function (ev) {
    dragging = true; startX = ev.clientX;
    wNow = clampDrawerWidth(parseFloat(getComputedStyle($("drawer")).width) || DRAWER_DEFAULT_WIDTH, innerWidth, sidebarNow());
    try { rz.setPointerCapture(ev.pointerId); } catch (e) {}
    ev.preventDefault();
  });
  rz.addEventListener("pointermove", function (ev) {
    if (!dragging) return;
    wNow = clampDrawerWidth(wNow - (ev.clientX - startX), innerWidth, sidebarNow()); // drag LEFT widens
    startX = ev.clientX;
    applyDrawerWidth(wNow);
  });
  rz.addEventListener("pointerup", function () {
    if (!dragging) return;
    dragging = false;
    localStorage.setItem(DRAWER_WIDTH_KEY, String(wNow)); // AD1 persistence pattern
  });
  rz.addEventListener("pointercancel", function () { dragging = false; });
})();

function applySidebarWidth(w) {
  document.documentElement.style.setProperty("--sidebar-w", String(clampSidebarWidth(w)) + "px");
}
function currentTheme() { return document.documentElement.dataset.theme || "dark"; }
function setTheme(t, persist) {
  document.documentElement.dataset.theme = t;
  if (persist) localStorage.setItem(THEME_CHOICE_KEY, t); // choice survives reload
}
(function initTheme() {
  var stored = localStorage.getItem(THEME_CHOICE_KEY);
  var theme = (stored === "light" || stored === "dark")
    ? stored // persisted choice wins
    : (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); // else follows the system
  setTheme(theme, false);
})();
$("themeToggle").addEventListener("click", function () {
  setTheme(currentTheme() === "dark" ? "light" : "dark", true);
});

(function initResize() {
  var saved = decodeStoredWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  applySidebarWidth(saved === null ? SIDEBAR_DEFAULT_WIDTH : saved);
  var rz = $("resizer");
  var dragging = false, startX = 0, widthNow = SIDEBAR_DEFAULT_WIDTH;
  rz.addEventListener("pointerdown", function (ev) {
    dragging = true; startX = ev.clientX;
    widthNow = clampSidebarWidth(parseFloat(getComputedStyle($("sidebar")).width) || SIDEBAR_DEFAULT_WIDTH);
    try { rz.setPointerCapture(ev.pointerId); } catch (e) {}
    document.body.classList.add("resizing"); rz.classList.add("active");
    ev.preventDefault();
  });
  rz.addEventListener("pointermove", function (ev) {
    if (!dragging) return;
    widthNow = clampSidebarWidth(widthNow + (ev.clientX - startX)); // live resize, clamped
    startX = ev.clientX;
    applySidebarWidth(widthNow);
  });
  rz.addEventListener("pointerup", function () {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing"); rz.classList.remove("active");
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(widthNow)); // persists across reload + session switch
  });
  rz.addEventListener("pointercancel", function () { dragging = false; document.body.classList.remove("resizing"); rz.classList.remove("active"); });
})();

// -- boot ----------------------------------------------------------------------
var filterTimer = null;
$("filter").addEventListener("input", function (ev) {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(function () { loadSessions(ev.target.value.trim()); }, 250);
});
(async function boot() {
  await loadConfig();
  status("config loaded (" + columns().length + " configured columns)");
  await loadSessions("");
  loadScanExtra();
})();
</script>
</body>
</html>
`

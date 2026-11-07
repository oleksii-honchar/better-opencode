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

// AD14 (owner card A): the AD13 per-lane FIT-WIDEN is REVERSED — "do not extend
// column". All 12 tracks return to exactly GRID_TRACK_PX; the per-lane width core,
// its override map and the fit math are DELETED outright (named delta with BEFORE/
// AFTER widths in task-ad14 evidence; the suite carries the negative greps — which
// is why this comment spells none of those identifiers). The
// owner's "unfold" is now delivered by WRAPPING full labels inside the track
// (header rules below + the declared one-step fit assist), never by width.
export function gridTrackTemplate(n: number): string {
  if (n <= 0) return ""
  return `repeat(${n}, ${GRID_TRACK_PX}px)`
}

// AD17 (owner: "grid header should use single row - not different height - it's ok
// to crop the titles"): headers are ONE uniform row for all lanes. The single-source
// tokens below give every header the SAME height by construction (one font, one line
// rhythm, one line tall); longer labels crop plain at the track edge (CSS overflow) —
// no per-header fit machinery exists anymore (AD14's multi-line model retired with its
// named-delta; the full names are carried by the column popup, AD13/AD14 mechanism).
export const HEADER_FONT_PX = 12 // tokenizes the pre-existing .col h2 font size (single source)
export const HEADER_LINE_H_PX = 14

// Row-hover band (card C): rows are contiguous at the derived pitch, so the nearest
// row from a Y offset is floor math on the grid's OWN rhythm. The edge tolerance is
// TWO pitch rows — generous for empty-area navigation inside the wall, honest beyond
// it (returns -1: the band HIDES, per card it never guesses a row).
export const ROW_HL_EDGE_TOL_PX = 24

// AD17 (owner: "do not use AMT abbr - use full words and also show full description
// in popup"): DISPLAY-LAYER de-abbreviation. The keys of these maps are DATA ids —
// nothing here rewrites a data key, category mapping, or id (join integrity is by
// construction: existing columns()/testid/category machinery consumes only the mapped
// string AT RENDER TIME). Overrides must stay minimal: exactly the lanes the owner named.
export const LANE_DISPLAY_OVERRIDES: Record<string, string> = {
  "amt-activity": "Agent Meta Tool Activity", // spells the abbreviation (unit-pinned surface)
}
// Tip-only description lines, worded from the shipped config/schema docs — no invented claims:
export const LANE_TIP_DESCRIPTIONS: Record<string, string> = {
  "amt-activity": "History lines emitted by the agent-meta-tool (agent.amt) history lane.",
}
export function laneDisplayLabel(catId: string, configuredLabel: string): string {
  return LANE_DISPLAY_OVERRIDES[catId] ?? configuredLabel // passthrough everywhere else, byte-identical
}

// AD25 — column-explainer content (owner card 2026-11-05: "Legend button + column-
// explainer overlay modal"). The card PINS these descriptions verbatim in intent —
// each describes what a CELL in that column MEANS (not where the data comes from).
// Rides beside the lane display definitions (card: "static registry beside the lane
// definitions"). Names must be the EXACT header display names the page renders for
// the shipped defaults — the drift lane in ui.test.ts byte-compares this table
// against laneDisplayLabel(defaultCategories()): rename a header, forget the
// registry ⇒ red. At runtime the modal lists every ACTIVE column in live config
// order (user-renamed/added lanes fall back to the header's own label path).
export const LEGEND_INTRO = "One row = one joined session event in time order; blocks are placed in the column matching the event type; hover a block for a quick preview card; click for the full details drawer."
export const LEGEND_ENTRIES: Array<{ id: string; name: string; description: string }> = [
  { id: "user-messages", name: "User Messages", description: "text the USER wrote to the agent (text parts, role user). One block = the agent received a user message at that moment." },
  { id: "assistant-text", name: "Assistant Text", description: "the agent's visible reply text (text parts, role assistant). One block = the agent was writing its response to the user. NOT the model's private thoughts (that is Reasoning)." },
  { id: "reasoning", name: "Reasoning", description: "the model's private thinking content (reasoning parts). Cell label shows its size in chars (0,Nk below 1k / Nk at 1k+). One block = the model produced a private thinking block at that moment." },
  { id: "tool-calls", name: "Tool Calls", description: "a tool or shell command was invoked (tool parts + tools.log). Cell label shows the tool name (e.g. 'bash'). One block = one invocation at that moment." },
  { id: "transitions", name: "Transitions", description: "persona decision-tree traversal events (persona.transition / TRN records): one agent moving between decision nodes." },
  { id: "pipeline", name: "Pipeline", description: "session-pipeline lifecycle commands recorded in history.jsonl: started, handoff, completed, error." },
  { id: "coach-judge", name: "Coach Judge", description: "coach judge evaluation events (plugin.judge): scoring/verdict records produced by the judge plugin." },
  { id: "coach-activity", name: "Coach Activity", description: "agent-coach activity events (agent.coach): the coach agent's own recorded actions; also deterministic gate-block notices enforced against agents in the session (gate-blocked, AD38)." },
  { id: "amt-activity", name: "Agent Meta Tool Activity", description: "agent meta-tool usage events (agent.amt): meta tool invocations made by an agent." },
  { id: "engine-nudges", name: "Engine Nudges", description: "engine injection nudges (plugin.nudge): deterministic reminders the engine pushed into an agent's context." },
  { id: "lifecycle", name: "Lifecycle", description: "session lifecycle artifacts from message parts: patches, compaction, file operations. Cell label names the lifecycle event (patch/compaction/file). Note: step-start/step-finish join-steps are EXCLUDED from display — they are join plumbing, not lane events." },
  { id: "other", name: "Other", description: "catch-all for anything not matching the lanes above." },
]

export function rowIndexNearestY(yRel: number, pitchPx: number, rowCount: number, edgeTolPx: number): number {
  if (rowCount <= 0) return -1
  if (yRel < -edgeTolPx || yRel > rowCount * pitchPx + edgeTolPx) return -1
  return Math.min(rowCount - 1, Math.max(0, Math.floor(yRel / pitchPx)))
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

// AD25: the legend modal consumes the SAME close-affordance contract as the AD4
// drawer (X + backdrop click + Escape). Separate core, identical semantics —
// Escape closes only while the legend is open; anything else is a no-op.
export function escShouldCloseLegend(key: string, legendOpen: boolean): boolean {
  return key === "Escape" && legendOpen
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
// evidence). The owner knob is exactly this one line: AD13 retunes 4 -> 2 (denser
// Arkanoid wall; the whole chain re-derives from this single edit — no other value
// moves by hand).
export const CELL_GUTTER_PX = 2
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
export const CELL_BLOCK_H_PX = 14
export const CELL_HIT_MIN_W_PX = 40
export const CELL_HIT_MIN_H_PX = 14
// AD16 (owner: "brick rows" look): visible width = track − 2 px inset per side (64−4=60),
// DERIVED from the chain like every other metric — the old literal 24 is retired (named delta).
// Horizontal hit re-derived to hit ≡ visible (the 44 comfort pad belonged to the small-chip era);
// vertical hit stays hit ≡ pitch (ad11/ad12 lane untouched). Comfort floor 40 holds by construction (60 ≥ 40).
export const CELL_CHIP_INSET_PX = 2
export const CELL_BLOCK_W_PX = GRID_TRACK_PX - 2 * CELL_CHIP_INSET_PX
export const CELL_HIT_W_PX = CELL_BLOCK_W_PX
export const CELL_HIT_H_PX = CELL_PITCH_PX
// AD19 — owner (2026-11-05): show the tool name inside tool-calls cells, "small font size
// to fit ~8-10px". 9 px is the served value; the owner band [8,10] is pinned by tests.
export const CELL_LABEL_FONT_PX = 9
// Label text vs brick, CONTRAST-CHOSEN per theme (evaluated 2026-11-05 on the tool-calls
// brick #d97706/#fbbf24 via WCAG): black scores 6.59 light / 12.58 dark — both far past
// the 3:1 floor; white fails dark (1.67). Re-verified from rendered pixels in the battery.
export const CELL_LABEL_TEXT_LIGHT = "#000"
export const CELL_LABEL_TEXT_DARK = "#000"

// AD19 pure label core — the row's OWN payload text (the same contract the drawer's
// callID link uses; fetchPayload(env.payloadRef)), nothing else. Chain: tool name →
// first token of the line detail → the literal floor. NEVER empty; NEVER truncates —
// the data layer carries the full name, cropping is CSS at render (AD17 discipline).
export function cellToolLabel(payloadText: unknown): string {
  if (typeof payloadText !== "string") return "tool"
  const looksJson = /^[{[]/.test(payloadText.trim()) // byte-capped heads still START with the JSON brace
  let parsed: any = null
  try { parsed = JSON.parse(payloadText) } catch (_e) { parsed = null }
  if (parsed && typeof parsed === "object") {
    if (parsed.type === "tool" && typeof parsed.tool === "string" && parsed.tool.trim().length > 0) return parsed.tool
    const detail = parsed.state && typeof parsed.state.detail === "string" ? parsed.state.detail : typeof parsed.detail === "string" ? parsed.detail : ""
    const token = detail.trim().split(/\s+/).filter(Boolean)[0]
    return token !== undefined ? token : "tool"
  }
  if (looksJson) {
    // TRUNCATED JSON (the payload endpoint caps by bytes): the name stays FIELD-VISIBLE in the
    // head — extract it, never leak raw JSON as a "token". Detail field first-token by the same
    // field contract; then the floor. (Names must match for EVERY tool-calls cell — card AC.)
    const toolField = payloadText.match(/"tool"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (toolField && toolField[1].trim().length > 0) return toolField[1]
    const detailField = payloadText.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    const detailToken = detailField ? detailField[1].trim().split(/\s+/).filter(Boolean)[0] : undefined
    return detailToken !== undefined ? detailToken : "tool"
  }
  const token = payloadText.trim().split(/\s+/).filter(Boolean)[0]
  return token !== undefined ? token : "tool"
}

// AD22 pure formatter — the JOIN-carried exact char count (TimelineEnvelope.contentChars)
// rendered in the owner's size form. n >= 1000: Math.round(n/1000) + "k" (UNCHANGED by every
// sub-1k ruling). AD24 (owner 2026-11-05, "below 1k show as 0,Nk") supersedes AD23's raw
// digits: 0 <= n < 1000 → "0," + clamp(round(n/100), 0, 9) + "k" — comma decimal per the
// owner's notation, ONE decimal, ROUNDED (consistent with the k-path at the boundary:
// 50→"0,1k"); tenths are CLAMPED so >=950 renders "0,9k" — a second decimal never appears
// and "1.0k" belongs to the integer path at n >= 1000. Non-numeric/negative floors to the
// same honest zero "0,0k" (no "-5"/"NaN" markers).
export function formatContentSize(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "0,0k"
  if (n < 1000) return "0," + Math.max(0, Math.min(9, Math.round(n / 100))) + "k"
  return Math.round(n / 1000) + "k"
}

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
// AD31 page-injected global set ONCE by applyColorsConfig at boot (module-ambient here for
// TS; erased at emit — the page defines the real var). Undefined server-side = palette truth.
declare const LANE_COLOR_CFG: Record<string, { bg?: string; bgDark?: string; text?: string; textDark?: string }> | undefined

export function deriveLabelColor(bgHex: string): string {
  // AD35 OWNER LAW (standing ruling; supersedes AD31's law + ESCAPE): direction fixed from
  // the bg's WCAG relative luminance — L < 0.45 → LIGHTER in-hue (HSL l +5% steps, h,s kept,
  // clamped at 95), else DARKER (clamped at 5). Stop when contrast(text,bg) >= 4.5; if the
  // chosen direction clamps first, that clamped in-hue extreme IS the result (never flip to
  // the other direction; the ratio it achieves is reported honestly in docs/evidence).
  // Pure, deterministic, self-contained (page-injectable). A result always exists (ladder).
  const hex = String(bgHex).toLowerCase()
  const toRgb = (h: string) => [0, 1, 2].map((i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255)
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  const lum = (h: string) => {
    const c = toRgb(h).map(lin)
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  // HSL round-trip preserving h and s exactly; only l steps ±5 (integer ladder).
  const rgbArr = toRgb(hex)
  const mx = Math.max(...rgbArr), mn = Math.min(...rgbArr)
  const l0 = (mx + mn) / 2
  const d = mx - mn
  let h0 = 0
  if (d > 0) {
    if (mx === rgbArr[0]) h0 = 60 * (((rgbArr[1] - rgbArr[2]) / d) % 6)
    else if (mx === rgbArr[1]) h0 = 60 * ((rgbArr[2] - rgbArr[0]) / d + 2)
    else h0 = 60 * ((rgbArr[0] - rgbArr[1]) / d + 4)
    if (h0 < 0) h0 += 360
  }
  const s0 = d === 0 ? 0 : d / (1 - Math.abs(2 * l0 - 1))
  const fromHsl = (hh: number, ss: number, ll: number) => {
    const c2 = (1 - Math.abs(2 * ll - 1)) * ss
    const x = c2 * (1 - Math.abs(((hh / 60) % 2) - 1))
    const m = ll - c2 / 2
    const seg = hh < 60 ? [c2, x, 0] : hh < 120 ? [x, c2, 0] : hh < 180 ? [0, c2, x] : hh < 240 ? [0, x, c2] : hh < 300 ? [x, 0, c2] : [c2, 0, x]
    return "#" + seg.map((v) => Math.round(Math.max(0, Math.min(1, v + m)) * 255).toString(16).padStart(2, "0")).join("")
  }
  // AD35 OWNER LAW (standing product ruling, supersedes the AD31 law INCLUDING its ESCAPE):
  // direction is FIXED by WCAG relative luminance — L < 0.45 → LIGHTER in-hue, else DARKER.
  // HSL lightness steps of 5%, CLAMPED at 95/5; stop at contrast >= 4.5, otherwise TERMINATE
  // AT THE CLAMP and return that max-in-direction color (achieved ratio is reported honestly;
  // the direction NEVER flips — "dark bg -> lighter text, period").
  const raise = lum(hex) < 0.45
  const clLo = 0.05, clHi = 0.95
  let last = fromHsl(h0, s0, Math.max(clLo, Math.min(clHi, l0)))
  for (let step = 5; step <= 100; step += 5) {
    const ll = raise ? Math.min(clHi, l0 + step / 100) : Math.max(clLo, l0 - step / 100)
    last = fromHsl(h0, s0, ll)
    if (contrast(last, hex) >= 4.5) return last
    if (raise ? ll >= clHi : ll <= clLo) break // clamp reached — law's terminal honest state
  }
  return last
}

// AD31: label text for a lane on a theme. EXPLICIT config text is used VERBATIM (owner's
// judgment — no clamping; the evidence table still reports its real ratio); otherwise the
// derivation law runs on the lane's EFFECTIVE bg (config bg when set, else palette — via the
// SAME laneBlockColor, so one bg source per lane-theme).
// AD34 (R2): per-theme order — theme override (textDark for dark / text for light) first,
// then the shared key (text serves both; textDark never leaks to light), then "auto" = the
// law on THIS theme's effective bg. An explicit "auto" keyword behaves like omission.
export function laneLabelTextColor(laneKey: string, themeMode: "light" | "dark"): string {
  var o = typeof LANE_COLOR_CFG !== "undefined" ? (LANE_COLOR_CFG as Record<string, { bg?: string; bgDark?: string; text?: string; textDark?: string }>)[laneKey] : undefined
  if (o) {
    if (themeMode === "dark" && o.textDark && o.textDark !== "auto") return o.textDark // theme override — verbatim
    if (o.text && o.text !== "auto") return o.text // explicit hex — verbatim
  }
  return deriveLabelColor(laneBlockColor(laneKey, themeMode))
}

export function laneBlockColor(laneKey: string, themeMode: "light" | "dark"): string {
  // AD31: config bg wins over the palette when set (applies to BOTH themes — documented
  // ruling). AD34 (R2): the per-theme candidate the same ruling named as "future" is now
  // built — theme override FIRST (bgDark for dark; bg is light's override and doubles as the
  // shared key), then the shared bg, then the palette. bgDark never leaks to light.
  // Server-side runtime has no LANE_COLOR_CFG (typeof-guarded) — palette truth for tests and
  // any non-page consumer.
  var cfg = typeof LANE_COLOR_CFG !== "undefined" ? (LANE_COLOR_CFG as Record<string, { bg?: string; bgDark?: string }>)[laneKey] : undefined
  if (cfg) {
    const themed = themeMode === "dark" ? cfg.bgDark : undefined
    if (themed) return themed
    if (cfg.bg) return cfg.bg
  }
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

// AD15 (owner: "replace \n with real newline, remove multiple escaping"): the ONE value-text
// channel for tree leaves. Strings pass through DECODED — the model already holds the true
// value; the old display-time JSON.stringify re-escaped it (literal \n, doubled backslashes).
// Nested-JSON strings show decoded-ONCE text — no reparse (declared boundary). Non-string
// kinds keep byte-stable String() text. The RAW view stays byte-exact via jsonBlock (untouched).
export function treeValueText(node: { kind: string; value: unknown }): string {
  return String(node.value)
}

// AD16 (owner screenshot: band a half-row BELOW the blocks): the band must share the block's
// CENTER line, not the row box's top. The renderer centers blocks inside the rendered row box;
// so the band centers on that SAME box (same-source rule — one geometry source, no new data).
export function bandCenterTop(rowBoxTop: number, rowBoxH: number, bandH: number): number {
  return Math.round(rowBoxTop + (rowBoxH - bandH) / 2)
}

// AD16 (owner: column popup should prefer TOP): the COLUMN TIP's own placement core —
// prefers ABOVE the anchor (tip.bottom ≤ anchor.top − gap), flips BELOW ONLY when the
// viewport lacks room above, x always clamped (same edge discipline as the card core).
// The hover CARD keeps computePopoverPlacement (unchanged surfaces stay unchanged).
export function topPreferredTipPlacement(
  anchor: { top: number; bottom: number; left: number; right: number },
  viewport: { top: number; left: number; width: number; height: number },
  tip: { width: number; height: number }
): { placement: "top" | "bottom"; x: number; y: number } {
  const margin = POPOVER_EDGE_MARGIN_PX
  const xMin = viewport.left + margin
  const xMax = viewport.left + viewport.width - tip.width - margin
  const aCx = (anchor.left + anchor.right) / 2
  const raw = aCx - tip.width / 2
  const x = Math.min(Math.max(raw, xMin), Math.max(xMin, xMax)) // clamp; never leaves the viewport (same as card core)
  const above = anchor.top - POPOVER_GAP_PX - tip.height
  if (above >= viewport.top + margin) return { placement: "top", x, y: above } // PREFERRED by owner instruction
  const below = anchor.bottom + POPOVER_GAP_PX
  if (below + tip.height <= viewport.top + viewport.height - margin) return { placement: "bottom", x, y: below }
  return { placement: "top", x, y: Math.max(above, viewport.top + margin) } // both tight: hold top, clamp into view — honest degenerate case, still no below-preference
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
  #themeToggle { width: 30px; height: 30px; padding: 0; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; flex: none; } /* AD25 NAMED DELTA: margin-left: auto MOVED to #legendButton (two auto margins split the free space and orphan the pair; the single auto margin now leads the right-hand group — the toggle's right-edge anchor is visually unchanged) */
  #themeToggle svg { width: 16px; height: 16px; display: block; margin: auto; }
  #themeToggle .i-moon { display: none; }                     /* dark (default): sun icon offers the flip */
  [data-theme="light"] #themeToggle .i-sun { display: none; } /* light: moon icon */
  [data-theme="light"] #themeToggle .i-moon { display: block; }
  #legendButton { margin-left: auto; height: 30px; padding: 0 10px; font: inherit; font-size: 12px; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; flex: none; } /* AD25: owns the right-group auto margin (see named delta above) — Legend sits LEFT of the toggle as its adjacent; same control tokens as the toggle (panel/line/ink/radius-8/height-30) = "styled consistently" */
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
  #stage { flex: 1; min-width: 0; overflow: auto; padding: 0 12px 12px; position: relative; } /* AD6: top gutter owned by the sticky livebar, not scrollable padding. AD14: positioning context for the in-scroll row band (absolute here = rides with rows, zero reposition code). */
  /* AD21 (owner 2026-11-05, "set #grid gap 4px"): LITERAL gap as asked — disambiguation
     resolved CASE A (card-bound): #grid has column tracks only (gridTrackTemplate) and its
     only children are the column divs; the row boxes live inside columns (margin-bottom
     pitch chain). No row tracks exist, so the row-gap half of the shorthand is structurally
     inert and CANNOT touch the owner-locked vertical rhythm (2px gutter / 16px pitch). */
  #grid { display: grid; gap: 4px; --cell-mini: ${CELL_MINI_H_PX}px; --cell-gutter: ${CELL_GUTTER_PX}px; --cell-pitch: ${CELL_PITCH_PX}px; --cell-block-w: ${CELL_BLOCK_W_PX}px; --cell-block-h: ${CELL_BLOCK_H_PX}px; --cell-hit-w: ${CELL_HIT_W_PX}px; --cell-hit-h: ${CELL_HIT_H_PX}px; --cell-label-font: ${CELL_LABEL_FONT_PX}px; --cell-label-text-light: ${CELL_LABEL_TEXT_LIGHT}; --cell-label-text-dark: ${CELL_LABEL_TEXT_DARK}; } /* AD6: items STRETCH (was align-items:start) so short columns keep their sticky headers bounded to full row height. AD7: the row PITCH lives here as the single source — AD11: pitch = box(--cell-mini)+gutter(--cell-gutter). AD12: the gutter is a FIXED constant (owner knob); --cell-pitch is the DERIVED rhythm, served for the chain — no independent value literals in the rules (L220). */
  .col { position: relative; } /* AD14: offset-parent for the row band's Y math (band top = col + slot offsets — read from the row ELEMENTS themselves) */
  .col h2 { font-size: ${HEADER_FONT_PX}px; line-height: ${HEADER_LINE_H_PX}px; margin: 0 0 6px; color: var(--dim); border-bottom: 1px solid var(--line); padding: 6px 0 4px; border-left: 1px solid var(--line); border-right: 1px solid var(--line); border-bottom-left-radius: 4px; border-bottom-right-radius: 4px; padding-left: 2px; position: sticky; top: 44px; z-index: 5; background: var(--bg); white-space: nowrap; overflow: hidden; } /* AD6: pins under the 44px livebar (top constant unchanged). AD17 NAMED SUPERSESSION (replaces the AD14 growing-wrap model): ONE uniform row — single line per header, PLAIN CROP at the track edge (no ellipsis machinery, per owner: "it's ok to crop the titles"). Equal heights are structural: every header shares these exact tokens and no per-header mutation exists. Full names ride si-col-tip for EVERY lane (AD13/AD14 surface). AD39 (owner instruction 2026-11-07, owner-supplied bytes verbatim — "make visual separation for grid headers"): border-left/right 1px solid var(--line) + bottom radii 4px + padding-left 2px, appended AFTER the padding shorthand so the literal declaration wins by order (owner-law: supplied bytes ARE the spec); nothing else in this rule moved, no new colors (var(--line) is the existing theme token). */
  /* AD10 trace mode (supersedes the AD7/AD9 mini-box visuals): a .cell is a
     TRANSPARENT row-pitch box — zero content, zero paint. The visible block is a
     ::after rounded rect painted from the per-column lane color (set once per
     column at buildGrid; theme rides the [data-theme] cascade below). Hover/click
     comfort is the ::before hit-area pseudo; the box itself takes no pointer
     events, so comfort never means "the whole row is clickable". Height stays
     var(--cell-mini): the AD7 1:1 row spine is unchanged — AD11 only NARROWED the
     pitch (box=14, gutter=→ token; vertical hit = pitch, adjacent hit rects touch,
     never overlap). Zero px literals in these rules (L220). */
  .cell { position: relative; cursor: pointer; pointer-events: none; height: var(--cell-mini, 14px); margin-bottom: var(--cell-gutter, 4px); padding: 0; /* AD21 (owner "div.cell padding to 0"): explicit no-padding; computed was already 0 — the ::after inset crop model is untouched */ }
  .cell::before { content: ""; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: var(--cell-hit-w, 44px); height: var(--cell-hit-h, var(--cell-pitch)); pointer-events: auto; } /* the interactive extension — height CONSUMES the pitch chain (AD12: hit ≡ pitch ⇒ adjacent hit rects gap 0, never overlap); events retarget to the cell (DOM-zero) */
  .cell::after { content: ""; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: var(--cell-block-w, 24px); height: var(--cell-block-h, 14px); border-radius: 4px; background: var(--block-light, var(--dim)); } /* the arkanoid block: solid, rounded, centered, zero content */
  [data-theme="dark"] .cell::after { background: var(--block-dark, var(--block-light, var(--dim))); } /* theme flip = the existing [data-theme] token path ONLY — no JS recolor path exists */
  /* AD19 — the ONLY in-cell content anywhere: the tool name inside TOOL-CALLS bricks (scoped
     supersession of zero-content; every other lane never builds this node). Geometry mirrors
     the ::after brick exactly (same anchor + width) so the crop boundary IS the brick:
     nowrap + overflow hidden — CROP IS THE DESIGN (AD17 discipline), no ellipsis duty.
     pointer-events none: pure decoration, the hit/Hover/drawer seams on the cell are untouched. */
  /* AD20 (owner polish): padding-left 1px + font-weight normal are the ONLY two edits to this
     rule. border-box STATES the present box model so the 1px lands INSIDE the existing box
     (content-box would widen the node to 61px and shift its center — the card forbids that). */
  .cell-label { box-sizing: border-box; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: var(--cell-block-w, 24px); padding-left: 1px; font-size: var(--cell-label-font, 9px); line-height: var(--cell-block-h, 14px); white-space: nowrap; overflow: hidden; text-align: left; pointer-events: none; z-index: 1; font-weight: normal; color: var(--cell-label-text, var(--cell-label-text-light, #000)); }
  [data-theme="dark"] .cell-label { /* AD31: the per-lane token (set at column build from explicit/auto law) is authoritative; the #000 here is only a pre-boot NO-JS fallback default — same honest-fallback pattern as the AD30 band height. */ color: var(--cell-label-text-dark, #000); } /* theme flip via the SAME token path */
  .slot { height: var(--cell-mini, 14px); margin-bottom: var(--cell-gutter, 4px); } /* invisible row-keeper: same pitch, zero chrome — the 1:1 alignment survives at the new rhythm */
  /* AD8 — payload tree + mode switch. ALL colors are theme tokens (both themes, no literals). */
  .payload-bar { display: flex; gap: 6px; align-items: center; margin: 6px 0; }
  .pmode { font: inherit; font-size: 12px; background: var(--badge); color: var(--dim); border: 1px solid var(--line); border-radius: 6px; padding: 2px 10px; cursor: pointer; }
  .pmode.on { color: var(--bg); background: var(--accent); border-color: var(--accent); }
  .pmode:disabled { opacity: 0.45; cursor: not-allowed; }
  .ptool { font: inherit; font-size: 12px; background: none; color: var(--dim); border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .payload-hint { color: var(--dim); font-size: 12px; margin: 2px 0 6px; }
  .jt_row { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .jt_value { white-space: pre-wrap; word-break: break-word; } /* AD15: explicit on the VALUE SPAN (card) — decoded newlines inside rows render as line breaks, long tokens wrap, no clipping */
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
  #coltip { position: fixed; left: 0; top: 0; z-index: 45; pointer-events: none; visibility: hidden; background: var(--tooltip); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; font-size: 12px; white-space: nowrap; } /* AD13: the ONE reused header tooltip (full lane label; replaces the native title — named delta). z 45: above the sticky headers (5) and the cell card (40), still below the drawer (60). */
  /* AD25 — column legend: SCREEN-level overlay (card: explicitly not an anchored popup).
     z ladder: backdrop 65 / panel 70 sit ABOVE the existing ladder (coltip 45, hovercard 40,
     drawer 60 — left untouched, re-pinned by tests). Open state = ONE body class; hidden by
     default; colors ride existing theme tokens only (no new palette); the panel scrolls its
     own content; swatches reuse the columns' --block-light/--block-dark var path (no JS repaint). */
  #legendBackdrop { position: fixed; inset: 0; background: rgba(2, 6, 16, 0.55); z-index: 65; display: none; }
  #legendModal { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(640px, 92vw); max-height: 82vh; display: none; flex-direction: column; overflow: hidden; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; z-index: 70; } /* AD26 (owner defect: scrollbar outside the rounded panel + scrolling header): PANEL is a clipping flex column — max-height cap and radius kept as AD24-shipped, overflow:hidden so NOTHING paints outside the curve. display:block→flex lives here AND the .legend-open rule below flips to flex. Scroll moved to #legendBody (inner scroller): its bar renders INSIDE the panel's padding, inset from the rounded edge. */
  #legendBody { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; } /* THE scroller: min-height:0 lets a flex-column child scroll; overscroll contain keeps the panel from ever panning */
  .legend-open #legendModal { display: flex; } /* was block (AD25) — the split needs the column layout */
  .legend-open #legendBackdrop { display: block; }
  /* (AD26: the open-state flip for #legendModal moved UP with the flex column layout — a later block rule here would defeat it) */
  .legend-open #grid { pointer-events: none; } /* hover/drawer suppressed while the modal is open (card-sanctioned route) */
  #legendModal .legend-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
  #legendModal .legend-head > span { font-weight: 600; font-size: 13px; }
  #legendClose { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; background: var(--badge); color: var(--accent); border: 1px solid var(--line); border-radius: 6px; cursor: pointer; padding: 0; }
  #legendClose svg { width: 14px; height: 14px; }
  #legendModal .legend-intro { color: var(--dim); font-size: 11px; margin: 0 0 10px; }
  .legend-row { display: flex; align-items: flex-start; gap: 10px; padding: 7px 2px; border-top: 1px solid var(--line); }
  .legend-swatch { width: var(--cell-block-w, 24px); height: var(--cell-block-h, 14px); border-radius: 4px; flex: none; margin-top: 3px; background: var(--block-light, var(--dim)); }
  [data-theme="dark"] .legend-swatch { background: var(--block-dark, var(--block-light, var(--dim))); } /* theme flip = the .cell::after token path, same names */
  #legendModal .legend-name { font-weight: 600; font-size: 12px; }
  #legendModal .legend-desc { color: var(--dim); font-size: 11px; }
  #coltip.show { visibility: visible; }
  #rowrect { position: absolute; left: 0; top: 0; width: 0; /* AD30: the height line below is now a FALLBACK-only pre-boot default — the show path overwrites band.style.height from ROW_BAND_PITCH (same variable as the top write); this var never inherits here (band is a sibling of #grid), which the old 16px default silently matched. */ height: var(--cell-pitch, 16px); background: color-mix(in srgb, var(--dim) 10%, transparent); z-index: 0; pointer-events: none; visibility: hidden; border-radius: 3px; } /* AD14 row-hover band: ONE reused strip living in the stage scroll (absolute here = rides rows with zero reposition code); FIRST DOM child + z 0 = above the plain stage bg, below the positioned blocks; tint composed ONLY from the existing dim token — subtle in both themes; never blocks a block. */
  #rowrect.show { visibility: visible; }
  .tip-desc { display: block; white-space: normal; max-width: 260px; color: var(--dim); font-size: 11px; margin-top: 2px; } /* AD17: optional second tip line, ONLY for lanes with a docs-sourced description; tokens only */
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
<header data-testid="si-header"><h1>Session Inspector</h1><span id="status"></span><button id="legendButton" data-testid="legend-button" type="button" aria-label="open the column legend">Legend</button><button id="themeToggle" data-testid="si-theme-toggle" type="button" aria-label="toggle light/dark theme"><svg class="i-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><svg class="i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor"/></svg></button></header>
<div id="legendBackdrop" data-testid="legend-backdrop"></div>
<div id="legendModal" data-testid="legend-modal" role="dialog" aria-label="column legend" aria-modal="true"><div class="legend-head"><span>Column Legend</span><button id="legendClose" data-testid="legend-close" type="button" aria-label="close legend"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div><div id="legendBody"><p class="legend-intro">${LEGEND_INTRO}</p><div id="legendRows"></div></div></div>
<main>
  <aside id="sidebar" data-testid="si-sidebar">
    <div id="filterdock" data-testid="si-filter-dock"><input id="filter" data-testid="si-filter" type="search" placeholder="filter sessions (server-side LIKE)"></div>
    <div id="sessions" data-testid="si-session-list"></div>
  </aside>
  <div id="resizer" data-testid="si-resizer" role="separator" aria-orientation="vertical" aria-label="resize sidebar"></div>
  <section id="stage" data-testid="si-stage"><div id="livebar" data-testid="si-livebar"><span id="live" class="off" data-testid="si-live-status">idle</span><button id="livebtn" data-testid="si-live-toggle">pause</button></div><div id="rowrect" data-testid="si-row-rect" aria-hidden="true"></div><div id="grid" data-testid="si-grid"></div><div id="empty" data-testid="si-empty">pick a session on the left - timeline streams in</div></section>
  <div id="drawerresizer" data-testid="si-drawer-resizer" title="drag to resize drawer"></div>
  <div id="hovercard" role="tooltip" aria-hidden="true" data-testid="si-hover-card"><span class="hc-ts" data-testid="si-hover-card-ts"></span><div class="hc-cat" data-testid="si-hover-card-cat"></div><div class="hc-src" data-testid="si-hover-card-src"></div><div class="hc-prev" data-testid="si-hover-card-preview"></div></div>
  <div id="coltip" role="tooltip" aria-hidden="true" data-testid="si-col-tip"></div>
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
var CONFIG_RETRY_MS = 5000; // AD32: the ONE disclosed retry interval (deviation flagged: no pre-existing interval existed to reuse — livebar is EventSource; the card's effective rule "no second interval invention" holds: this is the first and only).
var configRetryTimer = null;
async function loadConfig() {
  var res = await fetch("/session-inspector/config");
  if (!res.ok) {
    // AD32 R1 (developer ruling): the SHELL is the operator surface — invalid config no
    // longer leaves a dead page. R2: the DATA endpoints keep failing strict (§6.5/DEC-I
    // untouched); this branch surfaces that 500 body verbatim — code + exact schema
    // messages + path — and self-heals: poll checkConfigNow; on validity reload ONCE.
    // No stale-value rendering: the shell stays config-independent (empty grid area).
    var err = null;
    try { err = await res.json(); } catch (_e) { err = null; }
    var data = (err && err.data) || { code: "CONFIG_UNREADABLE", message: "HTTP " + res.status, path: "/session-inspector/config" };
    showConfigError(data);
    return false;
  }
  cfg = await res.json();
  if (cfg.configWarning) status("warning: " + cfg.configWarning.code);
  return true;
}
function showConfigError(data) {
  var bar = document.createElement("div");
  bar.id = "configBanner";
  bar.setAttribute("data-testid", "si-config-error");
  bar.style.cssText = "position:fixed;top:48px;left:16px;right:16px;z-index:80;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-size:13px"; // theme tokens = legible in BOTH themes
  var head = document.createElement("div");
  head.style.cssText = "font-weight:bold;margin-bottom:4px";
  head.textContent = "Config invalid (" + String(data.code) + ") — fix the file — this page reloads automatically when it is valid again";
  var msg = document.createElement("pre");
  msg.style.cssText = "white-space:pre-wrap;margin:0 0 8px;font-size:12px;color:var(--dim)";
  msg.textContent = String(data.message) + "\\npath: " + String(data.path); // emits "\n" for a REAL newline in the page string (verified via banner DOM read: no literal backslash rendered)
  var retry = document.createElement("button");
  retry.id = "configRetryBtn";
  retry.setAttribute("data-testid", "si-config-error-retry");
  retry.textContent = "Retry now";
  retry.onclick = function () { checkConfigNow(); }; // manual immediate poll — same mechanism
  bar.appendChild(head); bar.appendChild(msg); bar.appendChild(retry);
  document.body.appendChild(bar);
  if (!configRetryTimer) configRetryTimer = setInterval(checkConfigNow, CONFIG_RETRY_MS);
}
function checkConfigNow() {
  fetch("/session-inspector/config").then(function (r) {
    if (!r.ok) return; // still broken — keep waiting on the one interval
    if (configRetryTimer) { clearInterval(configRetryTimer); configRetryTimer = null; }
    var bar = document.getElementById("configBanner");
    if (bar) bar.innerHTML = ""; // one-transition reload statement; the fresh page re-reads the fixed file
    var head = bar ? bar.appendChild(document.createElement("div")) : document.body;
    head.textContent = "Config valid — reloading…";
    setTimeout(function () { location.reload(); }, 200);
  }).catch(function (_e) { /* server unreachable — next poll retries */ });
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
  // AD14 (named delta): the count form returns with the fit path — "do not extend column".
  grid.style.gridTemplateColumns = gridTrackTemplate(columns().length);
  columns().forEach(function (c, ci) {
    // AD13 (named delta): the native title attribute is REMOVED — the full label is
    // staved on the column node and served by the single reused si-col-tip surface.
    // AD17: the header and tip carry the DISPLAY label (de-abbrev, data id untouched —
    // testid and data-cat still consume the raw c.id); the optional description is staved
    // for the tip only. The cropped paint never travels: full text rides the tip.
    var head = h("h2", { "data-testid": siColHeaderTestId(c.id), text: laneDisplayLabel(c.id, c.title) });
    var col = h("div", { class: "col", "data-cat": c.id, "data-testid": siColTestId(c.id) }, head);
    head._label = laneDisplayLabel(c.id, c.title); // FULL display label for the tip — the cropped paint never travels
    head._desc = LANE_TIP_DESCRIPTIONS[c.id] || ""; // tip-only description line, docs-worded, only where defined
    col.style.minHeight = "60px";
    col.dataset.cellHeight = String(hh); // config cell height stays observable on the column (AD2 surface)
    // AD10: the column's block color — both theme steps computed ONCE from the
    // pure core and carried as vars; the [data-theme] cascade picks the step on
    // flip (no repaint path exists). Renamed/unknown lanes resolve deterministically.
    col.style.setProperty("--block-light", laneBlockColor(c.id, "light"));
    col.style.setProperty("--block-dark", laneBlockColor(c.id, "dark"));
    // AD31: per-lane label text (explicit verbatim | auto-derived against THIS lane's bg,
    // per theme) — same token path the CSS label channel already reads.
    col.style.setProperty("--cell-label-text-light", laneLabelTextColor(c.id, "light"));
    col.style.setProperty("--cell-label-text-dark", laneLabelTextColor(c.id, "dark"));
    rankById[c.id] = ci; // config column order = documented tie-order rank
    colById[c.id] = col;
    grid.appendChild(col); // AD17: no per-header fit pass — headers get their look from shared rules only
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
  // AD19 (scoped supersession of the zero-content rule — tool-calls ONLY): the tool name
  // appears INSIDE the brick. Source = the row's OWN payload via the drawer's payload
  // contract (fetchPayload(env.payloadRef)) — never a second data source. The core keeps
  // the full name at the data layer; the CSS clip does the crop. Every other category
  // never enters this branch (single gate, single call site — pinned by ad19 lanes).
  // Placed AFTER the placement loop so the AD7-seamed head of this function stays byte-stable.
  if (env.category === "tool-calls") {
    var lab = h("span", { class: "cell-label" });
    cell.appendChild(lab);
    fetchPayload(env.payloadRef).then(function (body) {
      // the drawer's OWN payload-text channel (objects → their JSON text; truncated rows
      // stay raw text): still the row's own payload, zero second data source.
      lab.textContent = cellToolLabel(body && body.payload != null ? payloadTextOf(body.payload) : "");
    }).catch(function (_e) { /* payload unreadable: the block degrades visibly, like the drawer */ });
  }
  // AD22 (second gated label lane, reasoning ONLY): the content length as NNNk, fed by the
  // JOIN-CARRIED exact count (env.contentChars) — a synchronous branch, deliberately NOT
  // fetchPayload-based: the payload endpoint is byte-capped and forbidden as a length source
  // (DEC-I). Same .cell-label channel (9px / weight normal / 1px padding / clip) — nothing restyled.
  if (env.category === "reasoning") {
    var rlab = h("span", { class: "cell-label" });
    rlab.textContent = formatContentSize(env.contentChars);
    cell.appendChild(rlab);
  }
  if (env.category === "lifecycle" && env.partType) { // AD27: the event kind, VERBATIM from the join field (AD22 data-path precedent); absent/unknown type → contentless brick, unchanged. Crop = same trailing-edge policy as tool names; full string lives in hover/drawer.
    var lclab = h("span", { class: "cell-label" });
    lclab.textContent = env.partType;
    cell.appendChild(lclab);
  }
  if (env.category === "engine-nudges" && env.nudgeKind) { // AD36: the nudge's OWN type string, VERBATIM from the record via the join field (lowercase happened at extraction, not here — the renderer holds NO vocabulary); headerless → bare brick (card). Same .cell-label channel + crop policy; full text in hover/drawer unchanged.
    var nl = h("span", { class: "cell-label" });
    nl.textContent = env.nudgeKind;
    cell.appendChild(nl);
  }
  if (env.category === "other" && env.historyEvent) { // AD37: the record's OWN event string, verbatim (join-parsed line.event carried as historyEvent); part-feed rows have no event field → bare brick, never stringified garbage. Same .cell-label channel + crop rule; AD35 tokens already theme-correct for the pink brick — zero new color math; full value in hover/drawer unchanged.
    var ol = h("span", { class: "cell-label" });
    ol.textContent = env.historyEvent;
    cell.appendChild(ol);
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
    row.appendChild(h("span", { class: "jt_value jt_" + node.kind, text: treeValueText(node) })); /* AD15: ONE plain-text channel — decoded strings, real newlines render (root cause: display-time JSON.stringify re-escaped values) */
  }
  return row;
}
function closeDrawer() {
  $("drawer").classList.remove("open"); $("drawerresizer").classList.remove("show"); // state-light: grid/selection/scroll untouched; AD5 divider hides with it
}
// AD4: document-level Esc (semantic core is unit-pinned; additive, no re-render).
document.addEventListener("keydown", function (ev) {
  if (escShouldCloseDrawer(ev.key, $("drawer").classList.contains("open"))) closeDrawer();
  if (escShouldCloseLegend(ev.key, document.body.classList.contains("legend-open"))) closeLegend(); // AD25: same Escape contract as the drawer (AD4), through its own core
});
// AD25 — column legend. Rows come from the LIVE config columns (every active lane,
// display order); names/descriptions are registry-fed, and a lane with no pinned entry
// falls back to the header's own label path — it never goes blank. Swatch vars reuse
// the columns' own pure color cores; opening hides floating surfaces and the body class
// makes the grid inert while the modal is open.
function legendEntry(catId) {
  for (var i = 0; i < LEGEND_ENTRIES.length; i++) { if (LEGEND_ENTRIES[i].id === catId) return LEGEND_ENTRIES[i]; }
  return null;
}
function buildLegendRows() {
  var box = $("legendRows");
  box.textContent = "";
  columns().forEach(function (c) {
    var e = legendEntry(c.id);
    var row = h("div", { class: "legend-row", "data-legend-cat": c.id });
    var sw = h("span", { class: "legend-swatch" }); // same cores, same var names as buildGrid's columns
    sw.style.setProperty("--block-light", laneBlockColor(c.id, "light"));
    sw.style.setProperty("--block-dark", laneBlockColor(c.id, "dark"));
    var text = h("div", { class: "legend-text" });
    text.appendChild(h("div", { class: "legend-name", text: e ? e.name : laneDisplayLabel(c.id, c.title) })); // registry first; unknown lane → the header's own path (single source)
    text.appendChild(h("div", { class: "legend-desc", text: e ? e.description : "No pinned description for this column." }));
    row.appendChild(sw); row.appendChild(text);
    box.appendChild(row); // the modal container ONLY — the grid is never touched
  });
}
function openLegend() {
  buildLegendRows(); hideHoverCard(); hideColTip(); // no floating surface survives above/behind the modal
  document.body.classList.add("legend-open");
  $("legendBody").scrollTop = 0; // AD26 re-open-at-top: reset AFTER the open flip — assigning scrollTop on a display:none scroller is a silent no-op (live defect: reopen kept 136px)
}
function closeLegend() {
  document.body.classList.remove("legend-open");
}
$("legendButton").addEventListener("click", openLegend);
$("legendBackdrop").addEventListener("click", closeLegend); // backdrop click = close (AD4-family close contract: X + backdrop + Esc)
$("legendClose").addEventListener("click", closeLegend);
var legendHead = $("legendModal").querySelector(".legend-head");
legendHead.addEventListener("wheel", function (ev) { // AD26 AC: header scrolls the list — the body is a SIBLING, no UA chain reaches it; explicit forward, consumes (nothing else can scroll here)
  $("legendBody").scrollTop += ev.deltaY; ev.preventDefault();
}, { passive: false });
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
// AD13: the header tooltip — ONE reused si-col-tip surface, IMMEDIATE (headers are
// large stable targets: the 150 ms intent delay belongs to the other target class,
// the 44px cells — POPOVER_INTENT_MS stays cell-only). Anchored through the SAME
// placement core (computePopoverPlacement — no second implementation). Content is
// only the full column label (col._label staved at build time). Mutual exclusion:
// showing one cancels the other; scroll hides both.
var colTip = null, colTipFor = null;
function showColTipFor(col) {
  hideHoverCard(); // mutual exclusion, column side
  var head = col && col.querySelector ? col.querySelector("h2") : null; // ANCHOR stays the column header (AD13 placement) — the TRIGGER was widened (AD14)
  if (!colTip) colTip = $("coltip");
  if (!colTip || !head || typeof head._label !== "string" || !head._label) return;
  if (colTip.textContent !== head._label || (head._desc && !colTip.querySelector(".tip-desc"))) {
    colTip.textContent = head._label; // label line = the full DISPLAY label (AD17: de-abbreviated)
    if (head._desc) { // optional description line — ONLY for lanes that define one (tip-only, never the header)
      var d = document.createElement("span");
      d.className = "tip-desc";
      d.textContent = head._desc;
      colTip.appendChild(d);
    }
  }
  colTip.classList.add("show");
  colTip.setAttribute("aria-hidden", "false");
  var p = topPreferredTipPlacement(head.getBoundingClientRect(), { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }, colTip.getBoundingClientRect()); // AD16 (owner): tip prefers ABOVE the header; flips below only when the top lacks room
  colTip.style.left = Math.round(p.x) + "px";
  colTip.style.top = Math.round(p.y) + "px";
  colTipFor = col;
}
function hideColTip() {
  colTipFor = null;
  if (colTip) { colTip.classList.remove("show"); colTip.setAttribute("aria-hidden", "true"); }
}
// AD14: the row-hover band + the ONE declared header-fit step. Both derive from the
// grid's OWN render data: a column's children ARE the rows (.cell/.slot appended in
// rowSlots order), so row index = child slot index and the band's Y reads from the
// row ELEMENT itself — immune to any header height configuration. The band is
// #rowrect: pointer-events none (never blocks a block), first-child + z 0 (under the
// blocks, over the stage bg), height = the derived pitch.
function showRowBandFor(idx) {
  var band = $("rowrect");
  if (!band) return;
  if (idx < 0) { band.classList.remove("show"); return; } // outside the wall: hide, never guess
  var col = $("grid").querySelector(".col");
  if (!col) return;
  var slot = col.children[1 + idx]; // rows ARE the column's appended children (the renderer's own order)
  if (!slot) return;
  band.style.width = $("stage").clientWidth + "px"; // full stage width per card (visible row)
  // AD16 (owner screenshot "band below the blocks"): the OLD row-box-TOP math is replaced by
  // CENTERING on the same rendered row box the renderer centers blocks in — same source, Δ ≤ 2 px.
  band.style.top = bandCenterTop(col.offsetTop + slot.offsetTop, slot.offsetHeight, ROW_BAND_PITCH) + "px";
  // AD30 (AD29 flag 3b ruling): the SAME variable that centers the band also SIZES it — the CSS
  // var(--cell-pitch) never inherits across the #grid sibling boundary (band is a #stage child).
  band.style.height = ROW_BAND_PITCH + "px";
  band.classList.add("show");
}
function hideRowBand() {
  var band = $("rowrect");
  if (band) band.classList.remove("show");
}
function rowIndexOfEl(el) {
  var kids = el.parentNode ? el.parentNode.children : [];
  var n = 0;
  for (var i = 1; i < kids.length; i++) { // children[0] is the header; the rest are the row slots
    if (kids[i] === el) return n;
    if (kids[i].classList && (kids[i].classList.contains("cell") || kids[i].classList.contains("slot"))) n++;
  }
  return -1;
}
$("grid").addEventListener("pointerover", function (ev) {
  var cell = ev.target && ev.target.closest ? ev.target.closest(".cell") : null;
  if (cell) {
    hideColTip(); // CELL STILL WINS (card B): the card shows ONLY — no stacking
    showRowBandFor(rowIndexOfEl(cell)); // row = its slot index in the column (the append-order contract)
    if (cell === hoverFor) return;
    hoverFor = cell;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(showHoverFor, POPOVER_INTENT_MS);
    return;
  }
  var col = ev.target && ev.target.closest ? ev.target.closest('[data-testid^="si-column-"]') : null; // AD14 (named delta on AD13): the trigger is the WHOLE column container — empty track included
  if (!col) { hideRowBand(); return; }
  if (col !== colTipFor) showColTipFor(col); // immediate, same anchoring/placement as AD13
  var first = col.children[1]; var ry = first ? ev.clientY - first.getBoundingClientRect().top : 0; // offset from row 0 — measured off the grid's own row element
  showRowBandFor(rowIndexNearestY(ry, ROW_BAND_PITCH, rowSlots.length, ROW_HL_EDGE_TOL_PX));
});
$("grid").addEventListener("pointerout", function (ev) {
  if (!(ev.relatedTarget && $("grid").contains(ev.relatedTarget))) { hideRowBand(); hideColTip(); } // leaving the grid entirely: band and column tip clear (band would follow scroll — its home IS the scroll space)
  var to = ev.relatedTarget && ev.relatedTarget.closest ? ev.relatedTarget.closest(".cell") : null;
  if (to && to === hoverFor) return; // moving within the SAME cell: keep intent
  hideHoverCard();
});
window.addEventListener("scroll", function () { hideHoverCard(); hideColTip(); }, true); // capture=true: hides BOTH surfaces on ANY scroller (stated choice; AD13 covers the header tip)

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

// AD2→AD14 track core (same injection discipline as AD1: browser and unit tests
// can never drift — the served track template IS the tested function). AD14 reverts
// the uniform form; the fit path is gone and is NOT served.
var GRID_TRACK_PX = ${GRID_TRACK_PX};
${gridTrackTemplate.toString()}
// AD14 row band + AD17 header/tip display layer — single-source as ever: these served
// values ARE the unit-tested tokens; the served helpers ARE the tested pure cores.
var HEADER_FONT_PX = ${HEADER_FONT_PX};
var HEADER_LINE_H_PX = ${HEADER_LINE_H_PX};
var ROW_HL_EDGE_TOL_PX = ${ROW_HL_EDGE_TOL_PX};
var ROW_BAND_PITCH = ${CELL_PITCH_PX}; // the derived rhythm — the band consumes the chain, never a literal
var LANE_DISPLAY_OVERRIDES = ${JSON.stringify(LANE_DISPLAY_OVERRIDES)};
var LANE_TIP_DESCRIPTIONS = ${JSON.stringify(LANE_TIP_DESCRIPTIONS)};
${laneDisplayLabel.toString()}
${rowIndexNearestY.toString()}
${bandCenterTop.toString()}
${topPreferredTipPlacement.toString()}
// AD19 tool-cell label core — same injection discipline: the served copy IS the tested core.
var CELL_LABEL_FONT_PX = ${CELL_LABEL_FONT_PX};
// AD28 derivation constants for the config override (CODE constants — the AD12 law
// re-derives from THESE, never from a literal; the apply function below is the only reader).
var CELL_MINI_H_PX = ${CELL_MINI_H_PX};
var CELL_GUTTER_PX = ${CELL_GUTTER_PX};
var CELL_CHIP_INSET_PX = ${CELL_CHIP_INSET_PX};
function applyGridConfig(cfg) {
  // AD28 single override point (card): called ONCE in boot() after loadConfig, before any render.
  // Absent/older/unreachable config ⇒ the injected constants ⇒ today's EXACT paint.
  var g = (cfg && cfg.ui && cfg.ui.grid) || {};
  var w = typeof g.columnWidthPx === "number" ? g.columnWidthPx : GRID_TRACK_PX;
  var h = typeof g.cellHeightPx === "number" ? g.cellHeightPx : CELL_MINI_H_PX;
  var fnt = typeof g.labelFontPx === "number" ? g.labelFontPx : CELL_LABEL_FONT_PX;
  var st = $("grid").style; // tokens = the CSS chain's single entry (block/hit/label centering all follow vars)
  st.setProperty("--cell-mini", h + "px");
  st.setProperty("--cell-gutter", CELL_GUTTER_PX + "px");
  st.setProperty("--cell-pitch", h + CELL_GUTTER_PX + "px"); // AD12 law: DERIVED from block + CODE gutter
  st.setProperty("--cell-block-w", w - 2 * CELL_CHIP_INSET_PX + "px"); // the current width derivation
  st.setProperty("--cell-block-h", h + "px");
  st.setProperty("--cell-hit-w", w - 2 * CELL_CHIP_INSET_PX + "px"); // hit ≡ visible (AD16 model)
  st.setProperty("--cell-hit-h", h + CELL_GUTTER_PX + "px"); // hit ≡ pitch (AD12 law)
  st.setProperty("--cell-label-font", fnt + "px"); // cell-label channel ONLY (header fonts untouched)
  GRID_TRACK_PX = w; // THE track source stays gridTrackTemplate — it reads this updated global
  ROW_BAND_PITCH = h + CELL_GUTTER_PX; // band centering + row index follow the same derived rhythm
  CELL_LABEL_FONT_PX = fnt;
}
var LANE_COLOR_CFG = {};
function applyColorsConfig(cfg) {
  // AD31: ONE call point, same apply-phase pattern as applyGridConfig — sets the per-lane
  // color overrides consumed by laneBlockColor/laneLabelTextColor at render. Absent section
  // = {} = all-auto: the derivation law applies to every built-in (the defect fix).
  LANE_COLOR_CFG = (cfg && cfg.ui && cfg.ui.colors) || {};
}
${cellToolLabel.toString()}
// AD22 content-size formatter — same discipline; input is the JOIN-carried exact count.
${formatContentSize.toString()}

// AD10 lane colors: the tested pure core and its vendored data, injected once.
// (CSS custom properties for the per-column steps are set in buildGrid; the
// block/hit metric vars are declared on #grid from the module constants above.)
var LANE_BLOCK_BASE = ${JSON.stringify(LANE_BLOCK_BASE)};
var LANE_BLOCK_OVERFLOW = ${JSON.stringify(LANE_BLOCK_OVERFLOW)};
${laneBlockColor.toString()}
// AD31: auto-readable label law + per-lane text resolver, injected next to the bg core they
// build on (same served-copy-is-the-tested-core discipline; both are pure over their inputs).
${deriveLabelColor.toString()}
${laneLabelTextColor.toString()}

// AD3 testid cores (same single-source injection; naming only — zero behavior).
${siRowTestId.toString()}
${siColTestId.toString()}
${siColHeaderTestId.toString()}
${siCellTestId.toString()}
${rowInsert.toString()}
var TREE_NODE_BUDGET = ${TREE_NODE_BUDGET};
var TREE_DEFAULT_EXPAND_DEPTH = ${TREE_DEFAULT_EXPAND_DEPTH};
${jsonTreeModel.toString()}
${treeValueText.toString()}
${initialTreeState.toString()}
${treeStateReducer.toString()}
var POPOVER_GAP_PX = ${POPOVER_GAP_PX};
var POPOVER_EDGE_MARGIN_PX = ${POPOVER_EDGE_MARGIN_PX};
var POPOVER_INTENT_MS = ${POPOVER_INTENT_MS};
var POPOVER_PREVIEW_CAP = ${POPOVER_PREVIEW_CAP};
${computePopoverPlacement.toString()}
${hoverPreviewText.toString()}
${escShouldCloseDrawer.toString()}
${escShouldCloseLegend.toString()}
// AD25 content registry (module-side single source, ui.test.ts drift-tested against
// laneDisplayLabel(defaultCategories())) — served as data, built at page build time:
var LEGEND_ENTRIES = ${JSON.stringify(LEGEND_ENTRIES)};

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
  var cfgOk = await loadConfig();
  if (!cfgOk) { status("config invalid — shell live, retrying"); return; } // AD32 R1: banner + self-heal poll own the page; NO partial render, NO dead boot
  applyGridConfig(cfg); // AD28: geometry override BEFORE any grid/render path exists (token vars + derived globals)
  applyColorsConfig(cfg); // AD31: color overrides — same boot point, renders read the map
  status("config loaded (" + columns().length + " configured columns)");
  await loadSessions("");
  loadScanExtra();
})();
</script>
</body>
</html>
`

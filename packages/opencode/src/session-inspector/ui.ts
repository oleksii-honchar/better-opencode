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
// Config keeps owning column SET/ORDER and cell HEIGHT (spec §7 "fixed for now"
// survives — heights don't flex). Widths flex: one `minmax(floor, 1fr)` track per
// configured column stretches to fill sidebar-edge→viewport-edge, floors at a
// readable minimum, and below the fit point the stage scrolls honestly (the floor
// is what makes that scroll an honest scrollbar instead of unreachable content).
// GRID_COL_MIN_PX is chosen by the fit math pinned in ui.test.ts: 12 default
// columns must fit a ~1910 vw desktop (12*120 + 11*10 = 1550 ≤ ~1600 px).

export const GRID_COL_MIN_PX = 120

export function gridTrackTemplate(n: number): string {
  const tracks: string[] = []
  for (let i = 0; i < n; i++) tracks.push(`minmax(${GRID_COL_MIN_PX}px, 1fr)`)
  return tracks.join(" ")
}

// AD3 — stable testid hooks (behavior-neutral; pure naming cores, single source:
// the served page injects THESE functions' compiled text, unit tests import them).
// Scheme (full table: materials/task-ad3-evidence.md):
//   static landmarks: si-header si-theme-toggle si-sidebar si-filter si-session-list
//     si-resizer si-stage si-livebar si-live-status si-live-toggle si-grid si-empty
//     si-drawer | drawer parts (runtime): si-drawer-meta si-drawer-payload
//     si-drawer-note si-drawer-source-absent | si-sessions-empty (absent-state)
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
  body { margin: 0; background: var(--bg); color: var(--ink); font: 13px/1.45 system-ui, sans-serif; }
  header { padding: 10px 16px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: baseline; position: sticky; top: 0; z-index: 20; background: var(--bg); }
  header h1 { font-size: 15px; margin: 0; }
  header #status { color: var(--dim); }
  #themeToggle { margin-left: auto; width: 30px; height: 30px; padding: 0; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; flex: none; }
  #themeToggle svg { width: 16px; height: 16px; display: block; margin: auto; }
  #themeToggle .i-moon { display: none; }                     /* dark (default): sun icon offers the flip */
  [data-theme="light"] #themeToggle .i-sun { display: none; } /* light: moon icon */
  [data-theme="light"] #themeToggle .i-moon { display: block; }
  main { display: flex; min-height: calc(100vh - 44px); }
  #sidebar { width: var(--sidebar-w, 280px); border-right: 1px solid var(--line); padding: 10px; flex: none; overflow-y: auto; max-height: calc(100vh - 44px); }
  #resizer { flex: none; width: 6px; margin: 0 -3px; cursor: col-resize; background: var(--line); opacity: 0.35; }
  #resizer:hover, #resizer.active { opacity: 1; }
  body.resizing { cursor: col-resize; user-select: none; }
  #filter { width: 100%; padding: 6px 8px; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; margin-bottom: 8px; }
  #sessions .row { padding: 6px 8px; border-radius: 6px; cursor: pointer; margin-bottom: 2px; }
  #sessions .row:hover { background: var(--panel); }
  #sessions .row.selected { background: var(--badge); }
  #sessions .row.child { margin-left: 18px; border-left: 2px solid var(--line); }
  #sessions .r1 { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #sessions .r2 { color: var(--dim); font-size: 11px; display: flex; gap: 6px; align-items: center; }
  .tag { font-size: 10px; padding: 0 6px; border-radius: 8px; background: var(--badge); color: var(--accent); }
  .tag.folder { background: var(--folder-bg); color: var(--warn); }
  #stage { flex: 1; min-width: 0; overflow: auto; padding: 12px; }
  #grid { display: grid; gap: 10px; align-items: start; }
  .col h2 { font-size: 12px; margin: 0 0 6px; color: var(--dim); border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  .cell { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; overflow: hidden; cursor: pointer; }
  .cell .preview { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; word-break: break-word; }
  .cell .cts { color: var(--dim); font-size: 10px; margin-bottom: 4px; display: block; }
  .cell:hover::after { content: attr(data-ts); position: absolute; right: 6px; bottom: 4px; background: var(--tooltip); border: 1px solid var(--line); padding: 1px 6px; border-radius: 6px; font-size: 10px; color: var(--accent); }
  .cell.clip::before { content: "•"; position: absolute; right: 6px; top: 4px; color: var(--warn); font-weight: 700; }
  .cell.unattr { opacity: 0.55; border-style: dashed; }
  .badges { margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
  #drawer { width: 0; flex: none; border-left: 1px solid var(--line); overflow: hidden; transition: width 120ms; max-height: calc(100vh - 44px); position: relative; }
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
  #livebar { display: flex; gap: 8px; align-items: center; padding: 4px 10px; border-bottom: 1px solid var(--line); }
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
    <input id="filter" data-testid="si-filter" type="search" placeholder="filter sessions (server-side LIKE)">
    <div id="sessions" data-testid="si-session-list"></div>
  </aside>
  <div id="resizer" data-testid="si-resizer" role="separator" aria-orientation="vertical" aria-label="resize sidebar"></div>
  <section id="stage" data-testid="si-stage"><div id="livebar" data-testid="si-livebar"><span id="live" class="off" data-testid="si-live-status">idle</span><button id="livebtn" data-testid="si-live-toggle">pause</button></div><div id="grid" data-testid="si-grid"></div><div id="empty" data-testid="si-empty">pick a session on the left - timeline streams in</div></section>
  <div id="drawerresizer" data-testid="si-drawer-resizer" title="drag to resize drawer"></div>
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
function buildGrid() {
  var grid = $("grid");
  grid.textContent = "";
  colById = {};
  var hh = (cfg.cell && cfg.cell.height) || 120;
  // AD2: tracks FILL the stage width (1fr) with the readable floor; config still
  // decides the COUNT and ORDER (columns()) — never a fixed px track here.
  grid.style.gridTemplateColumns = gridTrackTemplate(columns().length);
  columns().forEach(function (c) {
    var col = h("div", { class: "col", "data-cat": c.id, "data-testid": siColTestId(c.id) }, h("h2", { "data-testid": siColHeaderTestId(c.id), text: c.title }));
    col.style.minHeight = "60px";
    col.dataset.cellHeight = String(hh);
    colById[c.id] = col;
    grid.appendChild(col);
  });
}
var shown = 0, hiddenByConfig = 0, dropped = 0;
function appendCell(env) {
  var col = colById[env.category];
  if (!col) { hiddenByConfig++; status(current.id + ": " + shown + " rows" + (hiddenByConfig ? " (" + hiddenByConfig + " rows hidden: column removed from config)" : "")); return; }
  var hh = Number(col.dataset.cellHeight || 120);
  var sr = env.sourceRef || {};
  var cellSeq = Number(col._cellSeq || 0); // AD3 per-column monotonic seq (naming only)
  var cell = h("div", { class: "cell", "data-category": env.category, "data-testid": siCellTestId(env.category, cellSeq++), "data-db": sr.dbId || "", "data-ts": env.ts, title: env.ts, style: "width:100%;height:" + hh + "px", onclick: function () { openDrawer(env); } });
  col._cellSeq = cellSeq;
  cell.appendChild(h("span", { class: "cts", text: fmtTime(env.ts) }));
  cell.appendChild(h("div", { class: "preview", text: env.summary }));
  var badges = [];
  if (sr.bankAuthoritative) badges.push(h("span", { class: "tag bank", text: "bank" }));
  if (sr.attributed === false) badges.push(h("span", { class: "tag unattr", text: "unattributed" }));
  if (sr.lineage) badges.push(h("span", { class: "tag", text: sr.lineage === "db-parent" ? "db-sub" : "history-sub" }));
  if (badges.length) cell.appendChild(h("div", { class: "badges" }, badges[0], badges.slice(1)));
  col.appendChild(cell);
  shown++;
  // clip + dot indicator (client-observed) and payloadRef.truncated (server flag)
  requestAnimationFrame(function () {
    if (cell.scrollHeight > cell.clientHeight + 1 || (env.payloadRef && env.payloadRef.truncated === true)) cell.classList.add("clip");
  });
  status(current.id + ": " + shown + " rows" + (hiddenByConfig ? " (" + hiddenByConfig + " rows hidden: column removed from config)" : ""));
}
// ONE line parser for BOTH transports (Task 6 contract): the pushed SSE frames carry
// byte-identical envelope lines to the NDJSON timeline stream, so the client parses
// lines in exactly one place - a second parser could drift from the ratified shape.
function parseLine(s) { return JSON.parse(s); }
async function selectSession(id, title) {
  current = { id: id, title: title || id };
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
        if (cell) { cell.parentNode.removeChild(cell); if (shown > 0) shown--; }
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
  d.appendChild(jsonBlock(body.payload));
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
  d.appendChild(jsonBlock(body.payload));
}
function showLogLineFromHistory(env) {
  // history lines carry no callID: open the payload we have and say so explicitly
  var d = $("drawer");
  d.appendChild(h("div", { class: "note", text: "this source is a history line - no tools.log reference exists for it (none shown)" }));
}
function status(msg) { $("status").textContent = msg || ""; }

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

// AD2 responsive cores (same injection discipline as AD1: browser and unit tests
// can never drift — the served track template IS the tested function).
var GRID_COL_MIN_PX = ${GRID_COL_MIN_PX};
${gridTrackTemplate.toString()}

// AD3 testid cores (same single-source injection; naming only — zero behavior).
${siRowTestId.toString()}
${siColTestId.toString()}
${siColHeaderTestId.toString()}
${siCellTestId.toString()}
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

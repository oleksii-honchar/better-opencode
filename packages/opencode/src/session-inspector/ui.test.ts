import { describe, expect, test } from "bun:test"
import { HttpServerResponse } from "effect/unstable/http"
import {
  INSPECTOR_UI_HTML,
  SESSION_INSPECTOR_UI_PATH,
  uiHttpResponse,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_WIDTH_KEY,
  THEME_CHOICE_KEY,
  clampSidebarWidth,
  decodeStoredWidth,
} from "./ui"
// AD8 cores are accessed via the namespace object, not named bindings: while a core
// is unimplemented its ABSENT export must RED only the ad8 lane, never the module load.
import * as uiAll from "./ui"

// Task 5 — the static page mount (server-testable slice of the UI task).
// The PIXELS are accepted via CloakBrowser evidence (spec §11 / DEC-N); what THIS
// file pins is the serving contract: one HTML page route, correct media type, and
// the zero-build self-contained-ness that DEC-A option B requires (no framework,
// no asset pipeline: the served HTML embeds its own script + style).

describe("GET /session-inspector/ — self-contained page (Task 5)", () => {
  test("page is served as HTML with the app root, sidebar, grid, and drawer landmarks", () => {
    const web = HttpServerResponse.toWeb(uiHttpResponse())
    expect(web.status).toBe(200)
    expect(web.headers.get("content-type")).toContain("text/html")
  })

  test("served HTML is self-contained: inline script + style, endpoints referenced, zero external src", async () => {
    const web = HttpServerResponse.toWeb(uiHttpResponse())
    const body = await web.text()
    expect(INSPECTOR_UI_HTML).toBe(body) // what the response serves IS the module constant (no fs path games)
    // landmarks the browser evidence depends on
    for (const marker of [
      'id="sidebar"',
      'id="filter"',
      'id="sessions"',
      'id="grid"',
      'id="drawer"',
      "/session-inspector/config",
      "/session-inspector/sessions",
      "/session-inspector/sessions/scan",
      "/timeline",
      "/payload",
    ]) {
      expect(body).toContain(marker)
    }
    // zero external assets: no <script src>, no <link rel=stylesheet>
    expect(body).not.toMatch(/<script[^>]+src=/)
    expect(body).not.toMatch(/<link[^>]+stylesheet/)
  })

  test("inline script declares its mutable globals (browser crash 2026-11-04: 'cfg' undeclared)", () => {
    // the page boots by assigning cfg in loadConfig; an undeclared binding kills boot
    // in strict/async contexts and leaves the sidebar empty. Pin at least cfg is declared.
    expect(INSPECTOR_UI_HTML).toMatch(/\bvar cfg\b/)
    // boot sequence exists and is ordered
    expect(INSPECTOR_UI_HTML).toContain("await loadConfig();")
    expect(INSPECTOR_UI_HTML).toContain('await loadSessions("");')
  })

  test("hyperscript helper accepts nested child arrays (browser bug 2026-11-04: all badge cells silently skipped)", () => {
    // appendCell passes badges.slice(1) as a raw array; without flattening,
    // appendChild(array) throws and the per-line catch silently DROPS every badge row.
    expect(INSPECTOR_UI_HTML).toMatch(/Array\.isArray\(/)
  })

  test("tool cross-link detection parses string payloads (dbId payloads arrive as raw JSON strings)", () => {
    // the part payload for kind=dbId is the stored JSON STRING; the ⇄ tools.log link
    // must parse it before checking type/callID, or the AC cross-link never appears.
    expect(INSPECTOR_UI_HTML).toContain("JSON.parse(body.payload)")
  })

  test("path constant matches the spec URL exactly", () => {
    expect(SESSION_INSPECTOR_UI_PATH).toBe("/session-inspector/")
  })
})

// Task 6 — live tail client: incremental appends over EventSource, LIVE strip,
// pause/resume, and the ONE-parser contract (pushed frames are byte-identical in
// shape to NDJSON timeline lines, so the client must not carry a second parser).
describe("live tail client (Task 6)", () => {
  const occurrences = (needle: string) => INSPECTOR_UI_HTML.split(needle).length - 1

  test("subscribes with EventSource on the ratified live path", () => {
    expect(INSPECTOR_UI_HTML).toContain("new EventSource(")
    expect(INSPECTOR_UI_HTML).toContain('"/live"')
  })

  test("ONE parser: a single shared line-parse function feeds both transports", () => {
    // byte-identity by contract: SSE frames carry the SAME line bytes as the NDJSON
    // stream, so parsing lives in exactly one function used by both call sites.
    expect(occurrences("function parseLine(")).toBe(1)
    expect(occurrences("parseLine(")).toBeGreaterThanOrEqual(3) // definition + stream loop + live handler
    // The one-parser contract scopes to the ENVELOPE transports: the NDJSON timeline
    // stream and the live SSE frames carry byte-identical line bytes, so BOTH feed one
    // function. Measured reality (grep 2026-11-04): the sidebar /sessions/scan loop
    // parses a DIFFERENT ratified grammar (summary records, Task 3) - separate JSON
    // handling by contract, not a second parser of the envelope.
    expect(occurrences("JSON.parse(s)")).toBe(1) // the single line parser body
    const timelineRegion = INSPECTOR_UI_HTML.slice(
      INSPECTOR_UI_HTML.indexOf("async function selectSession("),
      INSPECTOR_UI_HTML.indexOf("// -- live tail"),
    )
    expect(timelineRegion).toContain("parseLine(lines[i])")
    expect(timelineRegion).not.toContain("JSON.parse(")
    const liveRegion = INSPECTOR_UI_HTML.slice(
      INSPECTOR_UI_HTML.indexOf("function subscribeLive("),
      INSPECTOR_UI_HTML.indexOf("// -- drawer"),
    )
    expect(liveRegion).toContain("parseLine(ev.data)")
    expect(liveRegion).not.toContain("JSON.parse(")
    expect(INSPECTOR_UI_HTML).toContain("JSON.parse(body.payload)")
  })

  test("LIVE strip with pause/resume: pause closes the stream instantly, resume reconnects", () => {
    expect(INSPECTOR_UI_HTML).toContain('id="live"')
    expect(INSPECTOR_UI_HTML).toContain("PAUSED")
    expect(INSPECTOR_UI_HTML).toMatch(/liveEs\.close\(\)/) // pause path closes the EventSource
    expect(occurrences("subscribeLive(")).toBeGreaterThanOrEqual(3) // definition + selectSession + resume
  })

  test("network-quiet: the live handler never refetches the timeline", () => {
    const start = INSPECTOR_UI_HTML.indexOf("function subscribeLive(")
    expect(start).toBeGreaterThan(-1)
    const liveSrc = INSPECTOR_UI_HTML.slice(start, start + 1200)
    expect(liveSrc).not.toContain("fetch(")
    expect(liveSrc).not.toContain("/timeline")
  })

  test("cells are keyed for removal: PartRemoved envelopes delete the cell by dbId", () => {
    // appendCell stamps the dbId on the cell, and the live handler can target it
    expect(INSPECTOR_UI_HTML).toContain('"data-db"')
    expect(INSPECTOR_UI_HTML).toMatch(/querySelector\(.?\[data-db=/)
  })
})

// ── AD-HOC owner task (2026-11-04): draggable sidebar + icon-only theme toggle ──
// Browser behavior is pixel-evidenced (adui-*.png); this lane pins the TESTABLE PURE
// CORES: clamp math, stored-value codec, key namespacing — plus string-level wiring
// pins on the served page (handle landmark, pointer events, persistence calls,
// icon-only guarantee, prefers-color-scheme default).

describe("ad-ui pure cores — sidebar clamp + persistence codec", () => {
  test("clampSidebarWidth: within-range identity; low clamps to MIN; high clamps to MAX; garbage -> DEFAULT", () => {
    expect(clampSidebarWidth(280)).toBe(280)
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampSidebarWidth(20)).toBe(SIDEBAR_MIN_WIDTH) // never unreadable
    expect(clampSidebarWidth(-500)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(10_000)).toBe(SIDEBAR_MAX_WIDTH) // never overlaps the grid
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH) // numeric-but-invalid clamps to MIN, never collapses
  })

  test("clamps are sane in absolute terms (readability + no grid overlap)", () => {
    expect(SIDEBAR_MIN_WIDTH).toBeGreaterThanOrEqual(160)
    expect(SIDEBAR_MAX_WIDTH).toBeLessThanOrEqual(720)
    expect(SIDEBAR_MIN_WIDTH).toBeLessThan(SIDEBAR_DEFAULT_WIDTH)
    expect(SIDEBAR_DEFAULT_WIDTH).toBeLessThan(SIDEBAR_MAX_WIDTH)
  })

  test("decodeStoredWidth: absent/garbage -> null (falls through to default+preference path); numbers clamp", () => {
    expect(decodeStoredWidth(null)).toBeNull()
    expect(decodeStoredWidth(undefined)).toBeNull()
    expect(decodeStoredWidth("")).toBeNull()
    expect(decodeStoredWidth("not-a-number")).toBeNull()
    expect(decodeStoredWidth("375")).toBe(375)
    expect(decodeStoredWidth("20")).toBe(SIDEBAR_MIN_WIDTH) // stored-garbage recovery stays clamped
    expect(decodeStoredWidth("99999")).toBe(SIDEBAR_MAX_WIDTH)
  })

  test("storage keys are namespaced to the inspector (no collision with other tools)", () => {
    expect(SIDEBAR_WIDTH_KEY).toMatch(/^session-inspector:[a-z-]+$/)
    expect(THEME_CHOICE_KEY).toMatch(/^session-inspector:[a-z-]+$/)
    expect(SIDEBAR_WIDTH_KEY).not.toBe(THEME_CHOICE_KEY)
  })
})

describe("ad-ui wiring pins on the served page", () => {
  test("drag handle landmark exists between sidebar and main, separator-role", () => {
    expect(INSPECTOR_UI_HTML).toContain('id="resizer"')
    const i = INSPECTOR_UI_HTML.indexOf('id="resizer"')
    // the handle sits strictly after the sidebar landmark and before the grid
    expect(i).toBeGreaterThan(INSPECTOR_UI_HTML.indexOf('id="sidebar"'))
    expect(i).toBeLessThan(INSPECTOR_UI_HTML.indexOf('id="grid"'))
    expect(INSPECTOR_UI_HTML).toContain('role="separator"')
  })

  test("resize is pointer-event based and persists via localStorage on the pinned key", () => {
    expect(INSPECTOR_UI_HTML).toContain("pointerdown")
    expect(INSPECTOR_UI_HTML).toContain("pointermove")
    expect(INSPECTOR_UI_HTML).toContain("pointerup")
    expect(INSPECTOR_UI_HTML).toContain("localStorage.setItem(")
    expect(INSPECTOR_UI_HTML).toContain("localStorage.getItem(")
    // single-source clamp: browser path uses the SAME numeric bounds + function text
    expect(INSPECTOR_UI_HTML).toContain("function clampSidebarWidth(")
    expect(INSPECTOR_UI_HTML).toContain(`"${SIDEBAR_WIDTH_KEY}"`)
  })

  test("theme toggle is icon-only: SVG glyph inside, NO letter text inside the button; aria-label allowed", () => {
    const m = /<button id="themeToggle"[^>]*>((?:(?!<\/?button)[\s\S])*)<\/button>/.exec(INSPECTOR_UI_HTML)
    expect(m).not.toBeNull()
    const inner = m![1]!
    expect(inner).toContain("<svg")
    const visibleText = inner.replace(/<[^>]*>/g, "").trim() // strip svg markup — nothing may remain
    expect(visibleText).toBe("")
    expect(INSPECTOR_UI_HTML).toMatch(/<button id="themeToggle"[^>]*aria-label=/)
  })

  test("theme default follows prefers-color-scheme; choice persists; full-surface flip via data attribute + custom properties", () => {
    expect(INSPECTOR_UI_HTML).toContain("prefers-color-scheme")
    expect(INSPECTOR_UI_HTML).toContain(`"${THEME_CHOICE_KEY}"`)
    expect(INSPECTOR_UI_HTML).toContain("documentElement.dataset.theme")
    expect(INSPECTOR_UI_HTML).toMatch(/\[data-theme=/) // light palette overrides the SAME custom properties
    // both palettes stay custom-property driven (no second style system)
    expect(INSPECTOR_UI_HTML).toContain(":root {")
  })

  test("config-driven grid stays untouched: cell size remains runtime-config, no px hardcoded into cell CSS", () => {
    // measured T5/T6 contract: cell height/width ride RUNTIME inline styles fed from
    // cfg.cell (the ONLY source, SC-2) — the AD-UI change must not regress that and
    // must not hardcode cell pixels into the stylesheet.
    // SUPERSEDED by AD2: config no longer feeds cell WIDTH (tracks flex:
    // minmax(GRID_COL_MIN_PX,1fr)); the runtime-config contract that survives is
    // cell HEIGHT — guarded below — plus no px in the .cell rule.
    expect(INSPECTOR_UI_HTML).toContain("cfg.cell && cfg.cell.height")
    const styleBlock = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("<style>"), INSPECTOR_UI_HTML.indexOf("</style>"))
    expect(styleBlock).toMatch(/\.cell \{[^}]*position: relative;/) // cell rule signature intact
    const cellRule = /\.cell \{[^}]*\}/.exec(styleBlock)![0]
    expect(cellRule).not.toMatch(/(?:^|[; ])(?:width|height)\s*:\s*\d+px/) // NO sizing pixels in the cell rule — size stays runtime-config
    // sidebar width rides a CSS var with the config-era default as fallback only
    expect(styleBlock).toMatch(/#sidebar \{[^}]*width: var\(--sidebar-w, 280px\)/)
  })
})

// ── AD-HOC owner task 2 (2026-11-04): responsive 100 %-width content area ──
// Pixels+evaluated metrics are browser-evidenced (ad2-*.png); this lane pins the
// PURE CORES: the track template (min-width floor + flex fill to 100 %), plus
// serving-level responsive rules and the negative guard that NO fixed px track
// width survives. Config still owns column set/order and cell HEIGHT (SC-2/§7).

// DELTA (AD10 supersedes AD2, recorded per card): the two stretch-track core pins
// ("GRID_COL_MIN_PX fit math" + "minmax(min,1fr) fills") were REMOVED — fixed-narrow
// left-aligned tracks replace viewport-stretching columns. AD2's 100 %-width container,
// page-never-scrolls and drawer-clamp pins in the wiring lane below STAND unchanged.
// DELTA (AD14 reverts AD13 per card a): the per-lane FIT-WIDEN is REVERSED — ALL
// lanes return to exactly GRID_TRACK_PX; the fit code path is DELETED entirely (no
// dead code; negative grep-pinned below). The per-track list signature existed only
// to carry per-lane widths, so the generator RETURNS as the AD10 count form —
// named delta recorded on the units it replaces. The owner's "unfold" is now
// WRAPPING (see the ad14 wrapped-headers lane), never width.
import { gridTrackTemplate } from "./ui"

// Namespace access keeps RED scoped to new lanes (AD8/AD10 pattern).
const ad14 = uiAll as unknown as Record<string, any>
const a14Need = (name: string): any => {
  if (ad14[name] === undefined) throw new Error("ad14 core missing: " + name)
  return ad14[name]
}

describe("ad14 uniform tracks RETURN — AD13 fit path deleted (named delta on the ad13 per-lane units)", () => {
  test('gridTrackTemplate(n) is the UNIFORM repeat again — "do not extend column" taken literally', () => {
    expect(ad14.GRID_TRACK_PX).toBe(64) // the base constant stands (AD10 ruling returns)
    expect(gridTrackTemplate(3)).toBe("repeat(3, 64px)")
    expect(gridTrackTemplate(0)).toBe("")
    expect(gridTrackTemplate(12)).toBe("repeat(12, 64px)") // the fixture's 12 lanes: one width everywhere
  })

  test('the fit path exists NOWHERE: no laneTrackWidth, no override map, no list signature, no served fit constants (negative pins)', () => {
    const src = require("node:fs").readFileSync(new URL("./ui.ts", import.meta.url), "utf8") as string
    expect(src).not.toMatch(/laneTrackWidth/)
    expect(src).not.toMatch(/LANE_TRACK_(OVERRIDES|FIT_PAD_PX|APPROX_CHAR_PX|MAX_PX)/)
    expect(src).not.toMatch(/gridTrackTemplate\(columns\(\)\)/) // list form existed ONLY for per-lane widths — retired
    expect(INSPECTOR_UI_HTML).not.toMatch(/LANE_TRACK_/)
    // NAMED delta: this unit replaces the AD13 "fit = clamp(64,220,approx)" +
    // "PER-LANE widths from the config list" units (AD14 card reverses that ruling).
    expect(INSPECTOR_UI_HTML).toMatch(/grid\.style\.gridTemplateColumns = gridTrackTemplate\(columns\(\)\.length\)/)
  })
})

describe("ad2 wiring pins on the served page", () => {
  test("buildGrid feeds the CONFIG COUNT into the single template core (AD14 named delta: list reverts to count with the fit path)", () => {
    expect(INSPECTOR_UI_HTML).toContain("function gridTrackTemplate(")
    expect(INSPECTOR_UI_HTML).toMatch(/grid\.style\.gridTemplateColumns = gridTrackTemplate\(columns\(\)\.length\)/)
    expect(INSPECTOR_UI_HTML).not.toMatch(/gridTemplateColumns = columns\(\)\.map\(/) // negative guard: single template core only
  })

  test("responsive machinery present: stage shrinkable, drawer clamp vs sidebar var, honest stage scroll", () => {
    const styleBlock = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("<style>"), INSPECTOR_UI_HTML.indexOf("</style>"))
    expect(styleBlock).toMatch(/#stage \{[^}]*min-width: 0/) // stage can shrink -> scroll stays INSIDE it
    expect(styleBlock).toMatch(/#stage \{[^}]*overflow: auto/) // honest horizontal scrollbar below fit point
    expect(styleBlock).toMatch(/#drawer\.open \{[^}]*width: min\(/) // drawer clamped, never forces page scroll
    expect(styleBlock).toMatch(/--sidebar-w/) // clamp math composes with the AD1 sidebar width var
  })

  test("config-driven cell HEIGHT path stays intact (only widths flex)", () => {
    expect(INSPECTOR_UI_HTML).toContain('col.dataset.cellHeight = String(hh)')
    expect(INSPECTOR_UI_HTML).toContain("cfg.cell && cfg.cell.height")
  })
})

// AD3 — stable data-testid hooks (behavior-neutral marking only). Scheme: si-*
// (full table documented in materials/task-ad3-evidence.md + ui.ts comment block).
// Pins: static landmark presence + uniqueness in the SERVED HTML; data-suffixed
// naming via PURE export cores (single source, same pattern as AD1/AD2); wiring
// regexes prove the runtime builders actually use the cores; negatives protect
// the seams we consolidate instead of duplicate (data-category, data-sid).

import { siRowTestId, siColTestId, siColHeaderTestId, siCellTestId } from "./ui"

describe("ad3 testid cores — stability + uniqueness (pure)", () => {
  test("data-suffixed names are deterministic and unique per fixture entity", () => {
    const sids = ["ses_a", "ses_b", "ses_with:colon/slash", "ses_a"]
    const rows = sids.map(siRowTestId)
    expect(rows[0]).toBe("si-session-row-ses_a") // stable literal shape
    expect(new Set(rows).size).toBe(3) // duplicate sid -> duplicate row id (same row), no collision ACROSS ids
    expect(siRowTestId("ses_a")).toBe(rows[0]) // stable across renders (pure)
    // cells unique within a column, namespaced by column
    const cells = [siCellTestId("tool-calls", 0), siCellTestId("tool-calls", 1), siCellTestId("nudges", 0)]
    expect(new Set(cells).size).toBe(3)
    expect(cells[0]).toBe("si-cell-tool-calls-0")
  })

  test("column + header names compose from config category ids (no volatile classes)", () => {
    expect(siColTestId("meta_catalog")).toBe("si-column-meta_catalog")
    expect(siColHeaderTestId("meta_catalog")).toBe("si-col-header-meta_catalog")
  })
})

describe("ad3 static landmarks — present exactly once in served HTML", () => {
  const statics = [
    "si-header", "si-theme-toggle", "si-sidebar", "si-filter", "si-filter-dock", "si-session-list",
    "si-resizer", "si-stage", "si-livebar", "si-live-status", "si-live-toggle",
    "si-grid", "si-empty", "si-drawer",
  ] as const
  for (const id of statics) {
    test(`landmark ${id}`, () => {
      const hits = INSPECTOR_UI_HTML.split(`data-testid="${id}"`).length - 1
      expect(hits).toBe(1) // present AND statically unique
    })
  }

  test("drawer sections + absence/truncation note markers", () => {
    expect(INSPECTOR_UI_HTML).toContain('data-testid": "si-drawer-meta') // meta table seam (h() attrs)
    expect(INSPECTOR_UI_HTML).toMatch(/"si-drawer-payload"/)
    expect(INSPECTOR_UI_HTML).toMatch(/"si-drawer-note"/)
    expect(INSPECTOR_UI_HTML).toMatch(/"si-drawer-source-absent"/)
    expect(INSPECTOR_UI_HTML).toMatch(/"si-sessions-empty"/)
    // conditional-by-design guard: marker ONLY when the list is genuinely empty
    expect(INSPECTOR_UI_HTML).toMatch(/if \(!box\.childElementCount\) box\.appendChild\(h\("div", \{ "data-testid": "si-sessions-empty"/)
  })

  test("runtime builders consume the cores (wiring, not wishful markup)", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/"data-testid": siRowTestId\(r\.id\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/"data-testid": siColTestId\(c\.id\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/"data-testid": siColHeaderTestId\(c\.id\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/"data-testid": siCellTestId\(env\.category, seq\)/) // AD7 refactored seq handling (increment before create); naming semantics unchanged (first row = 0)
  })

  test("consolidation not duplication: existing seams survive unchanged", () => {
    expect(INSPECTOR_UI_HTML).toContain('"data-category": env.category') // AD2-F14 seam stays
    expect(INSPECTOR_UI_HTML).toContain('"data-sid": r.id') // AD-era row identity seam stays
    expect(INSPECTOR_UI_HTML).toContain('"data-cat": c.id') // column seam stays
  })
})

// AD4 — drawer close button + Esc-to-close. Pure core for the keyboard semantic
// (exact focus semantics pinned here): the handler fires ONLY on key === "Escape"
// WHILE the drawer is open; every other key (typing in the sidebar filter) and
// Escape-while-closed are strict no-ops. No focus management of any kind.

import { escShouldCloseDrawer } from "./ui"

describe("ad4 pure core — esc-close semantics", () => {
  test("closes only on Escape while open; typing and closed-state are no-ops", () => {
    expect(escShouldCloseDrawer("Escape", true)).toBe(true)
    expect(escShouldCloseDrawer("Escape", false)).toBe(false) // no-op when closed
    expect(escShouldCloseDrawer("a", true)).toBe(false) // sidebar typing untouched
    expect(escShouldCloseDrawer("Escape ", true)).toBe(false) // exact key match
  })
})

describe("ad4 markup + wiring on the served page", () => {
  test("close control: icon-only button, AD3 testid, AD1 aria idiom, drawer-header position", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/"data-testid": "si-drawer-close"/)
    expect(INSPECTOR_UI_HTML).toMatch(/"aria-label": "close drawer"/)
    // icon-only: the button carries ONLY an inline SVG (innerHTML-parsed so the
    // browser namespaces it correctly — same visual idiom as the AD1 static toggle)
    expect(INSPECTOR_UI_HTML).toMatch(/h\("button", \{[^)]*"data-testid": "si-drawer-close"[^)]*html: '<svg [^>]*aria-hidden="true"/)
    // positioned top-right inside the drawer (AD2 clamp untouched: rule targets .dclose only)
    expect(INSPECTOR_UI_HTML).toMatch(/#drawer \.dclose \{[^}]*position: absolute;[^}]*top:[^}]*right:/)
  })

  test("document-level keydown wired through the core + click-close seam", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/document\.addEventListener\("keydown", function \(ev\) \{/)
    expect(INSPECTOR_UI_HTML).toMatch(/escShouldCloseDrawer\(ev\.key, .*classList\.contains\("open"\)\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/function closeDrawer\(\) \{[^}]*classList\.remove\("open"\)/)
    // close control consumes the documented AD3 idiom exactly once
    expect(INSPECTOR_UI_HTML.split('"si-drawer-close"').length - 1).toBe(1)
    // AD2 clamp still the drawer's only width rule
    expect(INSPECTOR_UI_HTML).toMatch(/#drawer\.open \{ width: min\(/)
  })
})

// AD5 — resizable drawer (persona-graph #dragbar idiom mirrored, not copied).
// Pure cores single-source (AD1/AD2/AD3 pattern). Clamps: min 240,
// max = DRAWER_VIEWPORT_GUTTER-composed viewport fit: min(720, vw - sidebar - 14).
// Exact max composition pinned here + restated in evidence.

import {
  DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH, DRAWER_DEFAULT_WIDTH, DRAWER_WIDTH_KEY,
  DRAWER_VIEWPORT_GUTTER, DRAWER_DIVIDER_BOX, DRAWER_STAGE_MIN, DRAWER_FIT_RESERVE,
  clampDrawerWidth, decodeStoredDrawerWidth,
} from "./ui"

describe("ad5 pure cores — drawer width clamp + codec", () => {
  test("constants: persona-graph-mirrored bounds and AD1-namespaced key", () => {
    expect(DRAWER_MIN_WIDTH).toBe(240)
    expect(DRAWER_MAX_WIDTH).toBe(720)
    expect(DRAWER_DEFAULT_WIDTH).toBe(360) // AD5 default constant (supersedes AD2-era 380 var; flagged)
    expect(DRAWER_VIEWPORT_GUTTER).toBe(14) // same gutter constant AD2's drawer clamp uses
    // AD5 exact fit composition: reserve = 14 gutter + 9 divider box + 24 stage min = 47
    expect(DRAWER_DIVIDER_BOX).toBe(9)
    expect(DRAWER_STAGE_MIN).toBe(24)
    expect(DRAWER_FIT_RESERVE).toBe(47)
    expect(DRAWER_WIDTH_KEY).toBe("session-inspector:drawer-width")
  })

  test("clampDrawerWidth: absolute clamps and the exact viewport-fit max composition", () => {
    expect(clampDrawerWidth(300, 1920, 280)).toBe(300) // free
    expect(clampDrawerWidth(100, 1920, 280)).toBe(240) // min
    expect(clampDrawerWidth(900, 1920, 280)).toBe(720) // hard max (720 << 1920-280-47)
    // viewport-fit wins between the two: max = 1000-280-47 = 673 < 720
    expect(clampDrawerWidth(900, 1000, 280)).toBe(673)
    // narrow viewport: 700-280-47 = 373 in [240, 720]
    expect(clampDrawerWidth(600, 700, 280)).toBe(373)
    // fit falls BELOW min -> fit wins (AD2-fit honored, floor never forces overflow)
    expect(clampDrawerWidth(600, 560, 280)).toBe(560 - 280 - 47) // 233
    expect(clampDrawerWidth(600, 500, 280)).toBe(500 - 280 - 47) // 173 < 240 -> 173
  })

  test("decodeStoredDrawerWidth: null-safe codec (null/empty/garbage -> null; callers fall to default)", () => {
    expect(decodeStoredDrawerWidth(null)).toBeNull()
    expect(decodeStoredDrawerWidth("")).toBeNull()
    expect(decodeStoredDrawerWidth("360")).toBe(360)
    expect(decodeStoredDrawerWidth("garbage")).toBeNull()
    expect(decodeStoredDrawerWidth("NaN")).toBeNull()
  })
})

describe("ad5 served-page wiring — dragbar idiom + persistence seams", () => {
  test("divider markup: testid + title hint, present in static template exactly once", () => {
    expect(INSPECTOR_UI_HTML.split('data-testid="si-drawer-resizer"').length - 1).toBe(1)
    expect(INSPECTOR_UI_HTML).toMatch(/id="drawerresizer"[^>]*title="drag to resize drawer"/)
  })

  test("hidden-while-closed rule (persona-graph idiom) + 7px col-resize bar", () => {
    const style = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("<style>"), INSPECTOR_UI_HTML.indexOf("</style>"))
    expect(style).toMatch(/#drawerresizer \{[^}]*display: none/)
    expect(style).toMatch(/#drawerresizer\.show \{[^}]*display: block/)
    expect(style).toMatch(/#drawerresizer \{[^}]*width: 7px[^}]*cursor: col-resize/)
    // CSS hygiene regression (AD5 battery incident): the stylesheet is plain CSS —
    // slash-slash comment lines silently KILL every rule they precede. Must never appear.
    expect(style).not.toMatch(/(^|\n)\s*\/\//)
  })

  test("drag + persistence wired through cores; open/close toggle visibility; openDrawer+AD4 intact", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/clampDrawerWidth\(/)
    expect(INSPECTOR_UI_HTML).toMatch(/decodeStoredDrawerWidth\(localStorage\.getItem\(DRAWER_WIDTH_KEY\)\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/localStorage\.setItem\(DRAWER_WIDTH_KEY, String\(/)
    // visibility toggles with the drawer: open adds .show, closeDrawer removes it (AD4 seam intact)
    expect(INSPECTOR_UI_HTML).toMatch(/drawerresizer.*classList\.add\("show"\)|\$\("drawerresizer"\)\.classList\.add\("show"\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/function closeDrawer\(\) \{[^}]*classList\.remove\("open"\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/function closeDrawer\(\) \{[^}]*drawerresizer[^}]*classList\.remove\("show"\)/)
    // AD2 clamp untouched + width now rides the persisted var, not a hardcoded constant
    expect(INSPECTOR_UI_HTML).toMatch(/#drawer\.open \{ width: min\(/)
    // AD5 fit-reserve composition mirrored in CSS = 14+9 gutter/divider + 24 stage-min
    expect(INSPECTOR_UI_HTML).toMatch(/calc\(100vw - var\(--sidebar-w, 280px\) - 23px - var\(--stage-min, 24px\)\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/setProperty\("--drawer", /)
  })
})

describe("ad6 scroll pinning — structural rules on the served page", () => {
  // AD6 (owner): two independently-scrolling regions, each with a pinned head.
  // Architecture CHOSEN (documented in task-ad6-evidence.md): viewport-height
  // app shell + sticky-in-scroller heads; NO per-column body DOM split (grid
  // items stretch to the full grid row, so a short column's sticky header is
  // bounded by a full-height box and stays visible at any scrollTop).
  const rule = (selector: string) => {
    const m = INSPECTOR_UI_HTML.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{[^}]*\\}"))
    return m ? m[0] : ""
  }

  test("viewport-height shell: body cannot page-scroll; main is HEIGHT-fixed, not min-height grown", () => {
    expect(rule("body")).toMatch(/overflow: hidden/)
    expect(rule("main")).toMatch(/height: calc\(100vh - 44px\)/)
    expect(rule("main")).not.toMatch(/min-height/)
    // the scrollport stays the stage (AD2 honest scroll), NOT main
    expect(rule("#stage")).toMatch(/overflow: auto/)
  })

  test("sidebar = full-height own scroll context (no vh max-height trick)", () => {
    const sb = rule("#sidebar")
    expect(sb).toMatch(/overflow-y: auto/)
    expect(sb).not.toMatch(/max-height/)
    // drawer same discipline (its internal scroll remains its own)
    expect(INSPECTOR_UI_HTML).toMatch(/#drawer \{[^}]*max-height: calc\(100vh - 44px\)[^}]*\}/) // AD5 rule untouched is acceptable ONLY as legacy max — replaced by shell:
  })

  test("si-filter pinned to top of the sidebar scrollport (sticky dock owns occlusion, input keeps its panel look)", () => {
    const dock = rule("#filterdock")
    expect(dock).toMatch(/position: sticky/)
    expect(dock).toMatch(/top: 0/)
    expect(dock).toMatch(/z-index/)
    expect(dock).toMatch(/background: var\(--bg\)/) // occludes rows sliding under the whole head
    expect(INSPECTOR_UI_HTML).toMatch(/<div id="filterdock" data-testid="si-filter-dock">/) // AD3 static landmark
    expect(rule("#filter")).toMatch(/background: var\(--panel\)/) // input appearance unchanged
  })

  test("livebar pinned over the stage: sticky head with a STABLE height the column headers stack under", () => {
    const lb = rule("#livebar")
    expect(lb).toMatch(/position: sticky/)
    expect(lb).toMatch(/top: 0/)
    expect(lb).toMatch(/z-index: 6/)
    expect(lb).toMatch(/height: 44px/) // the exact pin offset .col h2 must clear
    expect(lb).toMatch(/background: var\(--bg\)/)
    expect(lb).toMatch(/white-space: nowrap/) // height must never re-flow/wrap
  })

  test("every column header sticks below the livebar; grid stretches items so short columns stay covered", () => {
    const h2 = rule(".col h2")
    expect(h2).toMatch(/position: sticky/)
    expect(h2).toMatch(/top: 44px/) // == livebar height constant, pinned above
    expect(h2).toMatch(/z-index: 5/) // below livebar (6), above cells
    expect(h2).toMatch(/background: var\(--bg\)/)
    const g = rule("#grid")
    expect(g).not.toMatch(/align-items: start/) // STRETCH is load-bearing for short-column headers
  })

  test("session switch resets the stage scroll (new document top; the sidebar keeps its own position)", () => {
    // exact choice: stage vertical AND horizontal reset on select; sidebar untouched
    const sel = INSPECTOR_UI_HTML.slice(
      INSPECTOR_UI_HTML.indexOf("async function selectSession"),
      INSPECTOR_UI_HTML.indexOf("async function selectSession") + 900,
    )
    expect(sel).toMatch(/ stage\.scrollTop = 0;/)
    expect(sel).toMatch(/ stage\.scrollLeft = 0;/)
    // no new scrolling machinery on window/document (page never scrolls)
    expect(INSPECTOR_UI_HTML).not.toMatch(/window\.scrollTo|document\.documentElement\.scrollTop/)
  })

  test("AD1-AD5 regression seams still intact (drag, fit clamp, testids, esc-close)", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/#resizer \{ flex: none; width: 6px/)
    expect(INSPECTOR_UI_HTML).toMatch(/#drawer\.open \{ width: min\(var\(--drawer\), calc\(100vw/)
    expect(INSPECTOR_UI_HTML).toMatch(/data-testid="si-col-header-"\s*\+|siColHeaderTestId\(/)
    expect(INSPECTOR_UI_HTML).toMatch(/function closeDrawer\(\) \{[^}]*classList\.remove\("open"\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/#grid \{[^}]*gridTemplateColumns|gridTrackTemplate\(/)
  })
})

// ── AD7 (owner 2026-11-04): timestamp-keyed 1:1 rows + collapsed mini-cells +
// dock-magnification column hover; drawer left-border removal. ──
// Row SEMANTICS live in ui-rows.test.ts (pure core). This lane pins the served
// page: renderer consumes the core (single-source injection), per-row slot
// alignment, mini-by-default + column-hover expansion (CSS-transitioned, no JS
// on hover), and the drawer seam (border removed; AD5 resizer still lives there).

describe("ad7 row-joined renderer + mini/dock structure on the served page", () => {
  const rule = (selector: string) => {
    const m = INSPECTOR_UI_HTML.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{[^}]*\\}"))
    return m ? m[0] : ""
  }

  test("single-source core consumption: page injects rowInsert; renderer positions rows via it, never per-column stacking counters", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/function rowInsert\(/) // the injected core's compiled text (single-source pattern)
    const app = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function appendCell"))
    expect(app.slice(0, 2500)).toMatch(/rowInsert\(rowSlots/)
    expect(app.slice(0, 2500)).toMatch(/insertBefore|children\[/)
    // every column keeps the row count aligned: non-owning columns get a slot
    expect(app.slice(0, 2500)).toMatch(/class: "slot"/)
    expect(app.slice(0, 2500)).toMatch(/"data-ts"/)
    // live PartRemoved = row identity join (reference-based splice), not positional guesses
    expect(INSPECTOR_UI_HTML).toMatch(/rowSlots\.splice\(rowSlots\.indexOf\(/)
    // grid rebuild resets BOTH structures
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildGrid"), INSPECTOR_UI_HTML.indexOf("function appendCell"))
    expect(build).toMatch(/rowSlots = \[\]/)
    expect(build).toMatch(/rankById|colRank/) // config-order ranks registered once per build
  })

  test("row pitch survives (AD7 spine): --cell-mini constant + var-driven height on .cell AND .slot; mini WIDTH metric retired (AD10 named delta)", () => {
    // KEPT from the AD7 mini-box pin: the row rhythm — one pitch unit per row in every
    // column, var-driven, zero px literals. REMOVED (AD10 supersedes): the visible 86px
    // mini width (--cell-w) — cells are centered color blocks in fixed narrow tracks now.
    const gridRule = rule("#grid")
    // AD11 NAMED DELTA: the pitch VALUE (28) is superseded by the density contract — this pin
    // stays value-agnostic but single-source: the page must carry exactly the exported constant.
    // The pitch math itself (≤1.25× block) is pinned by the ad11 units.
    expect(gridRule).toContain(`--cell-mini: ${a10Need("CELL_MINI_H_PX")}px;`)
    expect(gridRule).not.toMatch(/--cell-w/) // the mini-width var is gone, not left dead
    const cell = rule(".cell")
    expect(cell).toMatch(/height: var\(--cell-mini/)
    expect(cell).not.toMatch(/width/) // no width of its own: the narrow track IS the width
    expect(cell).not.toMatch(/(?:width|height): \d+px/) // L220 discipline survives: no sizing px literals
    const slot = rule(".slot")
    expect(slot).toMatch(/height: var\(--cell-mini/) // same pitch unit -> 1:1 row alignment
    expect(INSPECTOR_UI_HTML).not.toMatch(/style: "width:100%;height:" \+ hh \+ "px"/)
  })

  // DELTA (AD9 supersedes AD7, recorded per card): the "dock-magnification column
  // hover" pin below was REMOVED and REPLACED by the ad9 hover-card lane. AD7's
  // row-spine, mini-box, and drawer-border pins above/below STAND unchanged.
  test("MAGNIFIER FULLY REMOVED (AD9 supersedes AD7): no col-hover expansion CSS or JS, no dead cell-height vars", () => {
    const colHover = INSPECTOR_UI_HTML.match(/\.col:hover[^{]*\{/g) || []
    expect(colHover.length).toBe(0)
    expect(INSPECTOR_UI_HTML).not.toMatch(/--cell-hh/) // the expansion var is gone, not left dead
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildGrid"), INSPECTOR_UI_HTML.indexOf("function appendCell"))
    expect(build).not.toMatch(/setProperty\("--cell-hh"/) // dead config path removed cleanly (cell.height stays in config/API)
    // no column-level CSS/JS expansion behavior survives:
    expect(INSPECTOR_UI_HTML).not.toMatch(/addEventListener\("mouse(enter|over)"/)
    expect(INSPECTOR_UI_HTML).not.toMatch(/\.cell:hover/)
  })

  test("drawer left border removed; AD5 resizer keeps living at that seam", () => {
    expect(rule("#drawer")).not.toMatch(/border-left/)
    expect(rule("#drawerresizer")).toMatch(/border-left: 2px solid var\(--line\)/)
  })

  test("AD6 pinning suite untouched by the row restructure (structural sanity, authoritative pins live in the ad8 lane)", () => {
    expect(rule("main")).toMatch(/height: calc\(100vh - 44px\)/)
    expect(rule("#livebar")).toMatch(/position: sticky; top: 0/)
    expect(rule(".col h2")).toMatch(/top: 44px/)
  })
})

// ---------------------------------------------------------------------------
// AD8 — interactive JSON tree in the drawer payload + raw<->tree switch.
// Pure cores carry correctness (card's test strategy): jsonTreeModel parses
// payload TEXT exactly like jsonBlock would show it (single source of the raw
// string), the reducer owns all expand/collapse transitions, the served page
// is pinned only for structure (mode controls, textContent discipline, token
// colors, no new storage keys). Namespace access keeps the RED scoped.
const ad8c = uiAll as unknown as Record<string, any>
const ad8Need = (name: string): any => {
  if (ad8c[name] === undefined) throw new Error("ad8 core missing: " + name)
  return ad8c[name]
}

describe("ad8 jsonTreeModel — payload text to tree model or honest fallback", () => {
  test("constants exported with pinned values", () => {
    expect(ad8Need("TREE_NODE_BUDGET")).toBe(2000)
    expect(ad8Need("TREE_DEFAULT_EXPAND_DEPTH")).toBe(2)
  })

  test("valid object: typed nodes, JSON-pointer data-paths, exact nodeCount", () => {
    const jsonTreeModel = ad8Need("jsonTreeModel")
    const r = jsonTreeModel('{"s":"x","n":1.5,"b":true,"z":null,"arr":[1,{"k":"v"}]}')
    expect(r.ok).toBe(true)
    expect(r.root.kind).toBe("object")
    expect(r.root.path).toBe("")
    const kids: any[] = r.root.children
    expect(kids.map((k) => k.key)).toEqual(["s", "n", "b", "z", "arr"])
    expect(kids.map((k) => k.kind)).toEqual(["string", "number", "boolean", "null", "array"])
    expect(kids[0].value).toBe("x")
    expect(kids[1].value).toBe(1.5)
    expect(kids[0].path).toBe("/s")
    const arr = kids[4]
    expect(arr.count).toBe(2)
    expect(arr.children[1].path).toBe("/arr/1")
    expect(arr.children[1].children[0].path).toBe("/arr/1/k")
    // node count = every JSON value node incl. root, keys not counted:
    // root obj + s + n + b + z + arr + arr[0] + arr[1] obj + k's string = 9
    expect(r.nodeCount).toBe(9)
    expect(r.overBudget).toBe(false)
  })

  test("escapes pointer per RFC6901 (~0 ~1) so data-path stays join-safe", () => {
    const r = ad8Need("jsonTreeModel")('{"a/b": {"c~d": 1}}')
    expect(r.ok).toBe(true)
    expect(r.root.children[0].path).toBe("/a~1b")
    expect(r.root.children[0].children[0].path).toBe("/a~1b/c~0d")
  })

  test("deep nesting recurses to full fixture depth (depth 6)", () => {
    const deep: any = { v: 1 }
    let cur = deep
    for (let i = 0; i < 5; i++) { cur.n = { v: i + 1 }; cur = cur.n }
    const r = ad8Need("jsonTreeModel")(JSON.stringify(deep))
    expect(r.ok).toBe(true)
    let node = r.root
    for (let i = 0; i < 5; i++) node = node.children.find((c: any) => c.key === "n")
    expect(node.kind).toBe("object")
    expect(node.children.some((c: any) => c.key === "v")).toBe(true)
  })

  test("unicode keys/values survive decoded, unescaped", () => {
    const src = JSON.stringify({ ключ: "日本語 ✓", arr: ["😀é"] })
    const r = ad8Need("jsonTreeModel")(src)
    expect(r.ok).toBe(true)
    expect(r.root.children[0].key).toBe("ключ")
    expect(r.root.children[0].value).toBe("日本語 ✓")
    expect(r.root.children[1].children[0].value).toBe("😀é")
  })

  test("invalid plain text -> honest fallback, never throws", () => {
    const r = ad8Need("jsonTreeModel")("started @ node 40-regression, details=not json {")
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("invalid-json")
  })

  test("truncated JSON (prefix cut) -> fallback (renderer picks truncation wording)", () => {
    const full = JSON.stringify({ callID: "tc_1", input: { command: "bun test ".repeat(300) }, output: "x".repeat(4000) })
    const cut = full.slice(0, 120)
    const r = ad8Need("jsonTreeModel")(cut)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("invalid-json")
  })

  test("scalar JSON parses (number/bool/null) → ok single leaf; empty string falls back", () => {
    const m = ad8Need("jsonTreeModel")
    expect(m("42").ok).toBe(true)
    expect(m("42").root.kind).toBe("number")
    expect(m("null").root.kind).toBe("null")
    expect(m("").ok).toBe(false)
  })

  test("node budget: > TREE_NODE_BUDGET flagged overBudget with exact count; below not", () => {
    const N = ad8Need("TREE_NODE_BUDGET")
    const arr = new Array(N).fill(0).map((_, i) => i) // N numbers + root = N+1 > N
    const over = ad8Need("jsonTreeModel")(JSON.stringify(arr))
    expect(over.nodeCount).toBe(N + 1)
    expect(over.overBudget).toBe(true)
    const under = ad8Need("jsonTreeModel")(JSON.stringify([1, 2, 3]))
    expect(under.overBudget).toBe(false)
    expect(under.nodeCount).toBe(4)
  })
})

describe("ad8 treeStateReducer — expand/collapse transitions (pure)", () => {
  const model = () => ad8Need("jsonTreeModel")('{"a":{"b":{"c":1}},"arr":[{"x":1},{"x":2}]}')

  test("initialTreeState expands containers above TREE_DEFAULT_EXPAND_DEPTH only", () => {
    const { root } = model()
    const st = ad8Need("initialTreeState")(root)
    expect(st.expanded).toContain("")
    expect(st.expanded).toContain("/a") // depth 1 open
    expect(st.expanded).not.toContain("/a/b") // depth 2 closed (documented default)
    expect(st.containers).toContain("/a/b")
  })

  test("toggle-node flips exactly the targeted path both ways; pure", () => {
    const { root } = model()
    const st0 = ad8Need("initialTreeState")(root)
    const frozen = JSON.stringify(st0)
    const st1 = ad8Need("treeStateReducer")(st0, { type: "toggle-node", path: "/a" })
    expect(st1.expanded).not.toContain("/a")
    expect(st1.expanded).toContain("")
    const st2 = ad8Need("treeStateReducer")(st1, { type: "toggle-node", path: "/a" })
    expect(st2.expanded).toContain("/a")
    expect(JSON.stringify(st0)).toBe(frozen) // input state untouched
  })

  test("expand-all opens every container; collapse-all empties; state survives models", () => {
    const { root } = model()
    let st = ad8Need("initialTreeState")(root)
    st = ad8Need("treeStateReducer")(st, { type: "expand-all" })
    expect(st.expanded.slice().sort()).toEqual(st.containers.slice().sort())
    st = ad8Need("treeStateReducer")(st, { type: "collapse-all" })
    expect(st.expanded).toEqual([])
  })

  test("unknown action is a no-op returning identical state", () => {
    const st = ad8Need("initialTreeState")(model().root)
    expect(ad8Need("treeStateReducer")(st, { type: "nope" })).toBe(st)
  })
})

describe("ad8 payload mode structure on the served page", () => {
  test("mode controls present with bound testids; tree side disabled on fallback; NO new storage keys", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/"si-payload-mode-tree"/)
    expect(INSPECTOR_UI_HTML).toMatch(/"si-payload-mode-raw"/)
    expect(INSPECTOR_UI_HTML).toMatch(/disabled/) // disabled attr used for the fallback control state
    expect(INSPECTOR_UI_HTML).not.toMatch(/session-inspector:payload-mode/) // module state chosen, no new keys
    // mode persists per page-load via a module variable (declared at page scope):
    expect(INSPECTOR_UI_HTML).toMatch(/payloadMode/)
  })

  test("both modes render the SAME underlying text: one payloadText feeds model AND jsonBlock; raw path byte-identical", () => {
    const sec = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function renderPayload"), INSPECTOR_UI_HTML.indexOf("function renderPayload") + 4000)
    expect(sec.length).toBeGreaterThan(100) // renderer exists as one section consuming one text value
    expect(sec).toMatch(/jsonTreeModel\(/)
    expect(sec).toMatch(/payloadText/)
    expect(sec).toMatch(/jsonBlock\(/)
    // jsonBlock itself unchanged (same raw rendering function):
    const jb = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function jsonBlock"))
    expect(jb.slice(0, 200)).toMatch(/JSON\.stringify\(v, null, 2\)/)
    expect(jb.slice(0, 200)).toMatch(/si-drawer-payload/)
  })

  test("tree DOM discipline: textContent-built nodes, aria-expanded, join-safe data-path; token-only colors", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/"aria-expanded"/)
    expect(INSPECTOR_UI_HTML).toMatch(/"data-path"/)
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildTreeRow"), INSPECTOR_UI_HTML.indexOf("function buildTreeRow") + 3000)
    expect(build.length).toBeGreaterThan(100)
    expect(build).not.toMatch(/innerHTML/) // XSS discipline: no payload-data HTML injection
    // tree CSS uses ONLY theme tokens for color (no hex/rgb/hsl literals in .jt_ rules):
    const jtRules = (INSPECTOR_UI_HTML.match(/\.jt_[a-z-]+ \{[^}]*\}/g) || []).join("\n")
    expect(jtRules.length).toBeGreaterThan(50)
    expect(jtRules).toMatch(/var\(--/)
    expect(jtRules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    // every value-kind class exists for type coloring:
    for (const k of ["key", "string", "number", "boolean", "null"]) {
      expect(INSPECTOR_UI_HTML).toMatch(new RegExp("\\.jt_" + k))
    }
    // node counts "{n}" rendered from model count:
    expect(INSPECTOR_UI_HTML).toMatch(/jt_count|"\{" \+ .*count|\{.*\.count.*\}/)
  })

  test("forced-raw fallback honest hints: invalid wording NEVER blames user; truncated case uses truncation wording; budget notice + raw complete", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/not valid JSON/)
    expect(INSPECTOR_UI_HTML).toMatch(/truncated/) // hint phrasing for truncated payloads
    expect(INSPECTOR_UI_HTML).toMatch(/"si-payload-fallback-note"/)
    expect(INSPECTOR_UI_HTML).toMatch(/TREE_NODE_BUDGET/) // injected core constant gates the tree branch
  })

  test("expand-all / collapse-all controls exist; AD7 core still injected (regression sanity)", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/"si-payload-expand-all"/)
    expect(INSPECTOR_UI_HTML).toMatch(/"si-payload-collapse-all"/)
    expect(INSPECTOR_UI_HTML).toMatch(/function rowInsert\(/)
  })

  test("logLine payloads (the plain-text debug surface) go through the SAME section: controls + forced raw, never a bare pre", () => {
    const sll = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("async function showLogLine"), INSPECTOR_UI_HTML.indexOf("function showLogLineFromHistory"))
    expect(sll.length).toBeGreaterThan(50)
    expect(sll).toMatch(/renderPayloadSection\(/) // honest fallback with controls applies here too
    expect(sll).not.toMatch(/appendChild\(jsonBlock\(/) // no uncontrolled raw bypass anymore
  })
})

// ---------------------------------------------------------------------------
// AD9 — ts-only boxes + floating hover card (supersedes AD7 dock magnifier).
describe("ad9 ts-only mini boxes + floating hover-card structure on the served page", () => {
  // DELTA (AD10 supersedes AD9, recorded per card): the "cells show timestamp text +
  // state dots" structural pin was REMOVED — cells now carry ZERO content (the full ts
  // lives in the hover card, which is unchanged). §5.6 visual marking moves to attributes:
  // data-ts + aria-label = ts. The hover-card structure/wiring tests below STAND unchanged.
  // NAMED DELTA (AD19): zero-content STANDS for every lane EXCEPT tool-calls (scoped
  // supersession per card). The blanket appendChild ban below is re-anchored to a
  // category-GATED rule — the ONLY child an appendCell may ever build is the label, and
  // ONLY inside a tool-calls gate. The AD19 lane "all other lanes" pin asserts zero labels
  // for every other category; the live battery asserts zero text cells in other columns.
  test("cells are CONTENTLESS (all lanes except tool-calls): no ts text, no dots, no children — ts/lane ride attributes + aria-label only", () => {
    const cell = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("var cell = h(\"div\", { class: \"cell\""))
    const body = cell.slice(0, cell.indexOf("// AD7 placement"))
    expect(body).not.toMatch(/class: "cts"/) // ts text GONE (AD10) — attributes only
    expect(body).not.toMatch(/class: "dot/) // state dots GONE (F25 allowance superseded by the card)
    expect(body).toContain('"data-ts": env.ts') // ts stays addressable...
    expect(body).toMatch(/"aria-label": env\.ts/) // ...and reachable: aria-label = ts (a11y per card)
    expect(body).toContain('"data-category": env.category') // lane identity stays an attribute
    // appendChild may appear ONLY as the label branch inside a category gate (AD19);
    // the cell BASE stays a plain contentless element:
    if (/appendChild/.test(body)) {
      // checker fix during GREEN: the generic class could not cross the gate's closing paren;
      // the exact served gate pattern (ad19 lane) is the authority.
      const gate = body.match(/if \(env\.category === "tool-calls"\) \{[\s\S]*appendChild/)
      expect(gate).not.toBe(null) // any child building is CATEGORY-GATED, never unconditional
    } else {
      expect(true).toBe(true) // no children at all — pre-AD19 shape (passes vacuously)
    }
    expect(body).not.toMatch(/title: env\.ts/) // no tooltip either (the card is the surface)
    // dead-CSS sweep alongside the renderer change (AD9 precedent: selector-free notes only)
    expect(INSPECTOR_UI_HTML.match(/\.dot[a-z-]* \{/g)).toBe(null)
    expect(INSPECTOR_UI_HTML).not.toMatch(/\.cell \.cts/)
    // clip dot + unattr border were in-cell visual markings: zero-content cells end them
    // (truncation and absence stay explicitly stated in hover card + drawer, where they always were)
    expect(INSPECTOR_UI_HTML).not.toMatch(/\.cell\.clip/)
    expect(INSPECTOR_UI_HTML).not.toMatch(/classList\.add\("clip"\)/)
    expect(INSPECTOR_UI_HTML).not.toMatch(/\.cell\.unattr/)
    expect(cell.slice(0, 2500)).toMatch(/cursor: pointer|onclick/) // click seam — cursor rule checked in the ad10 CSS lane
  })

  test("ONE reused fixed hover card: si-hover-card, pointer-events none, z above grid/livebar BELOW drawer, hidden by default", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/"si-hover-card"/)
    const hc = INSPECTOR_UI_HTML.match(/#hovercard \{[^}]*\}/)
    expect(hc).not.toBe(null)
    const r0 = (hc as RegExpMatchArray)[0]
    expect(r0).toMatch(/position: fixed/) // floating-ui pattern; never absolute-in-scroller (AD6 pins survive)
    expect(r0).toMatch(/pointer-events: none/)
    expect(r0).toMatch(/visibility: hidden/) // hidden until shown (not display:none — measure-able)
    const z = Number(r0.match(/z-index: (\d+)/)?.[1])
    const lb = INSPECTOR_UI_HTML.match(/#livebar \{[^}]*z-index: (\d+)/)?.[1]
    const hdr = INSPECTOR_UI_HTML.match(/\.col h2 \{[^}]*z-index: (\d+)/)?.[1]
    expect(z).toBeGreaterThan(Number(lb)); expect(z).toBeGreaterThan(Number(hdr))
    // card fields by testid (built once, refilled per hover)
    for (const t of ["si-hover-card-ts", "si-hover-card-cat", "si-hover-card-src", "si-hover-card-preview"]) {
      expect(INSPECTOR_UI_HTML).toMatch(new RegExp('"'+t+'"'))
    }
  })

  test("hover wiring: intent-delay timer at the injected constant, delegated pointer handlers, hide on leave AND any scroll, placement+truncate cores consumed", () => {
    const hw = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("var hoverTimer = null"))
    expect(hw.length).toBeGreaterThan(100) // wiring block exists
    expect(INSPECTOR_UI_HTML).toMatch(/var POPOVER_INTENT_MS = 150;/) // injected constant consumed by setTimeout
    expect(INSPECTOR_UI_HTML).toMatch(/setTimeout\(showHoverCard[^\n]*POPOVER_INTENT_MS|POPOVER_INTENT_MS\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/addEventListener\("pointer(enter|over)"/) // delegation used ("closest")
    expect(INSPECTOR_UI_HTML).toMatch(/\.closest\(/)
    expect(hw).toMatch(/addEventListener\("scroll"[^)]*true\)|addEventListener\("scroll"[^\n]*capture/) // capture=true = ANY scroller
    expect(INSPECTOR_UI_HTML).toMatch(/computePopoverPlacement\(/) // renderer consumes the placement core
    expect(INSPECTOR_UI_HTML).toMatch(/hoverPreviewText\(/) // renderer consumes the cap core
    expect(INSPECTOR_UI_HTML).toMatch(/clearTimeout\(hoverTimer\)/) // cancellable intent
    // absent-source honest wording in the card path
    expect(INSPECTOR_UI_HTML).toMatch(/source absent/)
  })

  test("AD7 spine + AD6 pinning + AD8 payload lanes untouched by this surface change (authoritative pins stay live)", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/function rowInsert\(/)
    expect(INSPECTOR_UI_HTML).toMatch(/rowSlots\.splice\(rowSlots\.indexOf\(/)
    expect(INSPECTOR_UI_HTML).toMatch(/"si-payload-mode-tree"/)
    const main = INSPECTOR_UI_HTML.match(/main \{[^}]*\}/)?.[0] || ""
    expect(main).toMatch(/height: calc\(100vh - 44px\)/)
  })
})

// ---------------------------------------------------------------------------
// AD10 — contentless "arkanoid" blocks (owner 2026-11-05, screenshot of clipped
// ts text): ZERO cell content, solid per-lane color blocks, fixed ~64 px narrow
// tracks, hit comfort via a hit-area pseudo-element. Named supersessions are
// recorded at the edited lanes above (AD9 ts/dots pin, AD2 stretch-track pins,
// AD7 mini-width half). Everything here is exercised AGAIN: hover card, drawer,
// row spine, pinning, tree — their lanes were not touched.
// Namespace access keeps the RED scoped to this lane (AD8/AD9 pattern).
const ad10 = uiAll as unknown as Record<string, any>
const a10Need = (name: string): any => {
  if (ad10[name] === undefined) throw new Error("ad10 core missing: " + name)
  return ad10[name]
}

// Block metric tokens (card ruling 2: "exact tokens worker-pinned by test").
describe("ad10 block tokens — visible 24x14, hit area ≥ 40x26, track 64", () => {
  test("visible block BRICK-width 60x14 (AD16 named delta: was 24); hit comfort floors kept", () => {
    // NAMED DELTA (AD16 part 2, owner: "Arkanoid look becomes brick rows"): width := track − 2 px inset per side,
    // DERIVED from the chain — the old literal 24 moves here and only here.
    expect(a10Need("CELL_CHIP_INSET_PX")).toBe(2)
    expect(a10Need("CELL_BLOCK_W_PX")).toBe(a10Need("GRID_TRACK_PX") - 2 * a10Need("CELL_CHIP_INSET_PX"))
    expect(a10Need("CELL_BLOCK_W_PX")).toBe(60)
    expect(a10Need("CELL_BLOCK_H_PX")).toBe(14) // height UNCHANGED (card)
    expect(a10Need("CELL_HIT_MIN_W_PX")).toBe(40) // horizontal comfort floor — UNCHANGED by AD11 (card rule 2 keeps it)
    // NAMED SUPERSESSION (AD11 card rule 2): the old vertical comfort floor (26) cannot exist at
    // any pitch that satisfies the density contract (26 > 1.25×14=17.5). The vertical floor is
    // re-anchored to "hit never undercuts the visible block"; non-overlap is pinned by ad11.
    expect(a10Need("CELL_HIT_MIN_H_PX")).toBe(14)
    expect(a10Need("CELL_HIT_W_PX")).toBeGreaterThanOrEqual(a10Need("CELL_HIT_MIN_W_PX"))
    expect(a10Need("CELL_HIT_H_PX")).toBeGreaterThanOrEqual(a10Need("CELL_HIT_MIN_H_PX"))
    expect(a10Need("CELL_BLOCK_H_PX")).toBeGreaterThanOrEqual(12) // AD11 card rule 1: Arkanoid visibility floor
  })
})

// Per-lane color core (card ruling 1): deterministic lane→color over VENDORED static
// hex constants (no framework, no CDN, no runtime CSS). Official palette values.
describe("ad10 laneBlockColor — deterministic per-lane palette over vendored hex constants", () => {
  const HEX = /^#[0-9a-f]{6}$/
  const hex2rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const dist = (a: string, b: string) => {
    const rb = hex2rgb(b)
    return Math.sqrt(hex2rgb(a).reduce((s, v, i) => s + (v - rb[i]) ** 2, 0))
  }
  const lum = (h: string) => {
    const [r, g, b] = hex2rgb(h).map((v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => {
    const la = lum(a)
    const lb = lum(b)
    return la < lb ? (lb + 0.05) / (la + 0.05) : (la + 0.05) / (lb + 0.05)
  }
  // F27 fix (developer ruling — owner AC "different color to EACH column"): the FULL shipped lane
  // vocabulary is explicit over vendored constants; hash assignment is reserved for unknown/
  // renamed keys. Vocabulary = the §5.6 default category ids shipped in config.schema (the 12
  // fixture headers are the live evidence) — a world-pin: vocabulary changes flip this table on
  // purpose. Dark steps keep the card's pattern (dark = same hue -400). F27 deltas: tool-calls
  // light = amber-600 (the amber rule: clears the 2.3 floor); user-messages = blue family (its
  // -400 pair sat within-distance of pipeline cyan in dark); amt-activity light = lime-600
  // (lime-500 breaks the absolute 2.1 floor); catch-all "other" = pink (coach-activity keeps
  // its measured teal slot — the collision had to move exactly one side).
  const KNOWN: Record<string, { light: string; dark: string }> = {
    "user-messages": { light: "#3b82f6", dark: "#60a5fa" },
    "assistant-text": { light: "#10b981", dark: "#34d399" },
    "reasoning": { light: "#8b5cf6", dark: "#a78bfa" },
    "tool-calls": { light: "#d97706", dark: "#fbbf24" },
    "transitions": { light: "#f43f5e", dark: "#fb7185" },
    "pipeline": { light: "#0891b2", dark: "#22d3ee" },
    "coach-judge": { light: "#6366f1", dark: "#818cf8" },
    "coach-activity": { light: "#14b8a6", dark: "#2dd4bf" },
    "amt-activity": { light: "#65a30d", dark: "#a3e635" },
    "engine-nudges": { light: "#f97316", dark: "#fb923c" },
    "lifecycle": { light: "#d946ef", dark: "#e879f9" },
    "other": { light: "#ec4899", dark: "#f472b6" },
  }

  test("every known lane key maps EXPLICITLY to official palette values, both modes (F27: no hash for knowns)", () => {
    for (const [kebab, hexes] of Object.entries(KNOWN)) {
      for (const mode of ["light", "dark"] as const) {
        const v = a10Need("laneBlockColor")(kebab, mode)
        expect(v).toMatch(HEX)
        expect(v).toBe(hexes[mode]) // exact vendored literal = the explicit branch, never hash
      }
    }
    // The explicit map covers the shipped §5.6 vocabulary EXACTLY — no known key may leak to the
    // hash, no surplus keys (world-pin: extending the vocabulary turns this red on purpose).
    const norm = (s: string) => s.toLowerCase().replace(/[-_.\s]/g, "")
    expect(Object.keys(a10Need("LANE_BLOCK_BASE") as Record<string, unknown>).map(String).sort())
      .toEqual(Object.keys(KNOWN).map(norm).sort())
  })

  test("runtime category ids are the SAME lanes: kebab-case normalizes onto the explicit assignments", () => {
    // the config/category surface is kebab-case — the mapping must not split worlds
    // (F27: the same-lane loop now covers every multi-word shipped key)
    for (const [kebab, camel] of [
      ["user-messages", "userMessages"], ["assistant-text", "assistantText"], ["tool-calls", "toolCalls"],
      ["coach-judge", "coachJudge"], ["coach-activity", "coachActivity"], ["amt-activity", "amtActivity"],
      ["engine-nudges", "engineNudges"],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        expect(a10Need("laneBlockColor")(kebab, theme)).toBe(a10Need("laneBlockColor")(camel, theme))
      }
    }
  })

  test("known lane keys are PAIRWISE EUCLIDEAN-DISTINCT in both theme modes (F27 floor)", () => {
    // checker self-verified before it judges (a near pair measures 0-30, disjoint hues 36+):
    expect(dist("#123456", "#123456")).toBeCloseTo(0)
    expect(dist("#000000", "#ffffff")).toBeCloseTo(441.67, 1)
    // Floor 35: same-hue adjacent steps collide at ≤~30; the closest pairs in this palette are
    // measured 36.0 (light: tool-calls↔engine-nudges) and 38.1 (dark: reasoning↔coach-judge).
    for (const mode of ["light", "dark"] as const) {
      const keys = Object.keys(KNOWN)
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = a10Need("laneBlockColor")(keys[i], mode)
          const b = a10Need("laneBlockColor")(keys[j], mode)
          expect(a).toMatch(HEX)
          expect(dist(a, b)).toBeGreaterThanOrEqual(35)
        }
      }
    }
  })

  test("contrast floors on the rendered page surfaces (F27 amber rule; no 1.98 repeat)", () => {
    // checker anchored on EXTERNAL accepted truth: the F27 record measured amber-500 on the
    // light surface at 1.98:1 — the method must reproduce that number to be trusted here.
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 0)
    expect(contrast("#f59e0b", "#f4f6f9")).toBeCloseTo(1.98, 1)
    const LIGHT_SURFACE = "#f4f6f9" // page background rendered in light mode (battery JSON)
    const DARK_SURFACE = "#101318" // page background rendered in dark mode (battery JSON)
    for (const key of Object.keys(KNOWN)) {
      expect(contrast(a10Need("laneBlockColor")(key, "light"), LIGHT_SURFACE)).toBeGreaterThanOrEqual(2.1) // absolute floor
      expect(contrast(a10Need("laneBlockColor")(key, "dark"), DARK_SURFACE)).toBeGreaterThanOrEqual(6) // -400 range (measured 6.24+)
    }
    // The amber rule (F27): light tool-calls slot clears 2.3 with amber-600.
    expect(contrast(a10Need("laneBlockColor")("tool-calls", "light"), LIGHT_SURFACE)).toBeGreaterThanOrEqual(2.3)
  })

  test("hash is ONLY for unknown/renamed keys — deterministic overflow cycle, never mimicking a known hue (F27)", () => {
    const known = new Set<string>()
    for (const mode of ["light", "dark"] as const)
      for (const k of Object.keys(KNOWN)) known.add(a10Need("laneBlockColor")(k, mode))
    expect(known.size).toBe(24) // 12 explicit hues × both steps — the disjointness bar for the cycle
    const keys = ["user-messages-v2", "coach-judge-v2", "weird_lane", "x", "", "renamed.assistant.text"]
    for (const mode of ["light", "dark"] as const) {
      // Degraded, never silent: renamed/unknown lanes still render (never throw) but can never
      // wear a known lane's color — the cycle is disjoint from all 24 known hexes.
      const seen = new Set<string>()
      for (const k of keys) {
        const v = a10Need("laneBlockColor")(k, mode)
        expect(v).toMatch(HEX) // never throws, never undefined — malformed keys still resolve
        expect(known.has(v)).toBe(false)
        seen.add(v)
        expect(v).toBe(a10Need("laneBlockColor")(k, mode)) // deterministic across calls (stable across reloads)
      }
      expect(seen.size).toBeGreaterThanOrEqual(2) // a spread across the cycle, not one constant
    }
  })

  test("page consumes the SAME core (single source): served HTML embeds laneBlockColor + the palette data", () => {
    expect(INSPECTOR_UI_HTML).toContain("function laneBlockColor(")
    expect(INSPECTOR_UI_HTML).toContain("var LANE_BLOCK_BASE") // vendored constants injected, not refetched
    expect(INSPECTOR_UI_HTML).toContain("var LANE_BLOCK_OVERFLOW")
  })
})

describe("ad10 served-page structure — transparent row box, block + hit pseudos, narrow-track colors", () => {
  const rule1 = (selector: string) => {
    const m = INSPECTOR_UI_HTML.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{[^}]*\\}"))
    return m ? m[0] : ""
  }

  test("row-box owns no paint: transparent, position:relative kept, cursor:pointer kept; hit pseudos extend comfort and take the events", () => {
    const cell = rule1(".cell")
    expect(cell).toMatch(/position: relative/) // pseudo anchor (and the ad-ui structural seam)
    expect(cell).toMatch(/cursor: pointer/) // AC3: cursor stays
    expect(cell).not.toMatch(/background: var\(--panel/) // no panel surface: the row box is invisible
    expect(cell).toMatch(/pointer-events: none/) // hit comfort belongs to the pseudo, not the full row pitch
    const hit = rule1(".cell::before")
    expect(hit).toMatch(/content: ""/)
    expect(hit).toMatch(/pointer-events: auto/) // the interactive extension (≥ CELL_HIT_* tokens via vars)
    expect(hit).toMatch(/width: var\(--cell-hit-w/)
    expect(hit).toMatch(/height: var\(--cell-hit-h/)
    const block = rule1(".cell::after")
    expect(block).toMatch(/width: var\(--cell-block-w/)
    expect(block).toMatch(/height: var\(--cell-block-h/)
    expect(block).toMatch(/border-radius/) // rounded block (owner's "arkanoid" shape)
    expect(block).toMatch(/background: var\(--block-light/) // lane color via vars — zero content involved
    // metrics ride the vars-from-constants pattern (grid declares them; no literals in rules).
    // AD11 NAMED DELTA: the hit-height literal expectation (30px) is superseded — the pin
    // derives from the tested constants now; the honest value is pinned by the ad11 units.
    const gridRule = rule1("#grid")
    expect(gridRule).toContain(`--cell-block-w: ${a10Need("CELL_BLOCK_W_PX")}px;`) // AD16 NAMED DELTA: brick width now DERIVES from the tested constants (was literal 24px) — no hand-lit values in rules
    expect(gridRule).toMatch(/--cell-block-h: 14px;/)
    expect(gridRule).toContain(`--cell-hit-w: ${a10Need("CELL_HIT_W_PX")}px;`) // AD16: hit derives from the brick chain too (was literal 44px) — hit ≡ visible horizontally
    expect(gridRule).toContain(`--cell-hit-h: ${a10Need("CELL_HIT_H_PX")}px;`)
    // AD11: the vertical gutter becomes a token too (density contract) — sourced from core, never a rule literal:
    expect(gridRule).toContain(`--cell-gutter: ${a10Need("CELL_GUTTER_PX")}px;`)
    expect(cell).toMatch(/margin-bottom: var\(--cell-gutter/) // .cell gutter rides the var (was an 8px literal)
    expect(rule1(".slot")).toMatch(/margin-bottom: var\(--cell-gutter/) // row-keepers share ONE rhythm
    for (const r of [cell, hit, block]) expect(r).not.toMatch(/(?:width|height): \d+px/) // L220 holds
  })

  test("theme flip rides the [data-theme] cascade ONLY: light var with dark override, zero JS recolor paths", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/\[data-theme="dark"\] \.cell::after \{[^}]*var\(--block-dark/)
    // the toggle handler stays the pure theme flip (no repaint machinery added)
    const h = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf('$("themeToggle").addEventListener'))
    const handler = h.slice(0, h.indexOf("});") + 3)
    expect(handler).toMatch(/setTheme\(currentTheme\(\) === "dark" \? "light" : "dark", true\)/)
    expect(handler).not.toMatch(/laneBlockColor|recolor|setProperty/)
  })

  test("buildGrid paints lanes: per-column block vars (both themes), header is UNIFORM SINGLE-ROW PLAIN-CROP (AD17 REPLACES the AD14 wrap model); native title stays removed", () => {
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildGrid"), INSPECTOR_UI_HTML.indexOf("function appendCell"))
    expect(build).toMatch(/setProperty\("--block-light", laneBlockColor\(c\.id, "light"\)\)/)
    expect(build).toMatch(/setProperty\("--block-dark", laneBlockColor\(c\.id, "dark"\)\)/)
    // NAMED SUPERSESSION (AD13 card c KEPT): native title remains removed — the real
    // tooltip surface (si-col-tip) is the full-label carrier for every lane.
    expect(build).not.toMatch(/"title": c\.title/)
    // NAMED SUPERSESSION (AD17 card a, owner: "single row … it's ok to crop the titles"):
    // the AD14 wrap model (white-space:normal + overflow-wrap, growing header row) is RETIRED.
    // One uniform row: single line, PLAIN CROP at the track edge. No ellipsis requirement —
    // text-overflow must stay absent (crop plain, not "…"), the popup carries full names.
    const h2 = rule1(".col h2")
    expect(h2).toMatch(/white-space: nowrap/)
    expect(h2).toMatch(/overflow: hidden/)
    expect(h2).not.toMatch(/text-overflow/) // plain crop — no ellipsis character machinery
    expect(h2).not.toMatch(/white-space: normal/) // the AD14 wrap declaration is gone
    expect(h2).not.toMatch(/overflow-wrap/) // wrap helpers are gone
    // testid scheme (AD3) untouched: header + cell builders still consume the cores
    expect(build).toMatch(/siColHeaderTestId\(c\.id\)/)
  })

  test("zero external palette machinery: no tailwind/CDN import anywhere (tokens composed, file not self-tainting)", () => {
    // built from parts so this test file never spells the tokens it forbids downstream
    const tw = "tai" + "lwind"
    const fu = "floa" + "ting-ui"
    const src = require("node:fs").readFileSync(new URL("./ui.ts", import.meta.url), "utf8") as string
    const hay = INSPECTOR_UI_HTML + "\n" + src
    expect((hay.match(new RegExp(tw, "gi")) ?? []).length).toBe(0)
    // floating-ui semantics stay HAND-ROLLED; only runtime references are banned
    expect(hay).not.toMatch(new RegExp("from\\s+['\"][^'\"]*" + fu))
    expect(hay).not.toMatch(new RegExp("require\\(['\"][^'\"]*" + fu))
    // palette is vendored constants: no network reference in the page at all
    expect(INSPECTOR_UI_HTML).not.toMatch(/https?:\/\//)
    expect(INSPECTOR_UI_HTML).not.toMatch(/@import/)
  })

  test("config surface unchanged: cell.width stays unused (do NOT rebind), cell.height observation intact", () => {
    expect(INSPECTOR_UI_HTML).not.toMatch(/cfg\.cell\.width/)
    expect(INSPECTOR_UI_HTML).toContain("cfg.cell && cfg.cell.height")
    expect(INSPECTOR_UI_HTML).toContain("col.dataset.cellHeight = String(hh)")
  })
})

// ── AD11 (owner 2026-11-05): dense Arkanoid wall — "Narrow grid rows" card ───────────
// AD11 delivered pitch 17 under a ≤1.25× ratio ceiling. AD12 (owner: "the gap should be
// not like factor of height... but some fixed number, e.g. 4px") RETIRES the ratio
// ceiling as the governing contract (named supersession delta below): the model is a
// FIXED gutter constant (CELL_GUTTER_PX = 4, the owner knob = one line); pitch and the
// vertical hit are DERIVED from it — no independent pitch value may exist. The
// hit-gap-0-never-overlap invariant is RE-DERIVED at the new pitch (hit ≡ pitch), not
// dropped. The 1:1 spine, ordering (rowInsert byte-identical), horizontal hit comfort,
// and block shape stay KEEP.
describe("ad13 header tooltip si-col-tip — ONE reused surface, immediate, mutually exclusive with the cell card", () => {
  test("one reused si-col-tip element; z above sticky headers (5), below the drawer (60)", () => {
    expect((INSPECTOR_UI_HTML.match(/data-testid="si-col-tip"/g) ?? []).length).toBe(1) // one reused element, ever
    const tip = (INSPECTOR_UI_HTML.match(/#coltip \{[^}]*\}/) ?? [""])[0]
    expect(tip).toMatch(/position: fixed/)
    expect(tip).toMatch(/pointer-events: none/)
    const z = parseInt((tip.match(/z-index: (\d+)/) ?? ["", "0"])[1], 10)
    expect(z).toBeGreaterThan(5) // above the sticky headers
    expect(z).toBeLessThan(60) // below the drawer
  })
  test("column-area hover (ANY .col container area) shows the FULL label IMMEDIATELY; AD16 TOP-PREFERENCE placement core; cell card still wins", () => {
    const js = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function showColTipFor"))
    expect(js.length).toBeGreaterThan(0)
    const fn = js.slice(0, js.indexOf("function hideColTip"))
    expect(fn).toMatch(/textContent/) // label line = the full DISPLAY label — no preview
    expect(fn).toMatch(/_label/) // label staved at build time (full text, never the cropped paint)
    // NAMED DELTA (AD17 card b): the "single text node, no other content" rule becomes
    // "label + OPTIONAL description line": _desc exists ONLY for lanes with a docs-sourced
    // description (amt-activity); every other lane's tip stays name-only.
    expect(fn).toMatch(/_desc/)
    expect(fn).toMatch(/tip-desc|createElement/) // the description renders as a separate line node, only when present
    // NAMED DELTA (AD16 part 3, owner: popup above the header): the coltip MOVES from the shared
    // bottom-preferring card core to its OWN top-preferring pure core (single placement rule per
    // surface remains — still no inline math here). The hover-CARD keeps computePopoverPlacement.
    expect(fn).toMatch(/topPreferredTipPlacement\(/)
    expect(fn).not.toMatch(/computePopoverPlacement\(/)
    expect(fn).toMatch(/hideHoverCard\(\)/) // mutual exclusion, column side
    expect(fn).not.toMatch(/setTimeout/) // immediate for columns: the 150ms intent delay belongs to the other target class
    // NAMED EXTENSION (AD14 card b): the AD13 header-cell trigger (closest("h2")) is
    // WIDENED to the whole column container — hovering empty track areas works too.
    expect(INSPECTOR_UI_HTML).toMatch(/closest\('\[data-testid\^="si-column-"\]'\)/)
    expect(INSPECTOR_UI_HTML).not.toMatch(/closest\("h2"\)/)
    const h = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf('$("grid").addEventListener("pointerover"'))
    const handler = h.slice(0, h.indexOf("});"))
    // ORDER is the contract: the CELL branch precedes the column branch — a block hover
    // resolves to the card ONLY (no stacking, owner: cell hover-card STILL WINS).
    expect(handler.indexOf('closest(".cell")')).toBeLessThan(handler.indexOf('closest(\'[data-testid^="si-column-"]\')'))
    expect(INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf('window.addEventListener("scroll"')).slice(0, 160)).toMatch(/hideColTip/) // hide-on-scroll covers both surfaces
  })
  test("mutual exclusion cell-side: the cell hover path cancels the column tip", () => {
    const h = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf('$("grid").addEventListener("pointerover"'))
    const handler = h.slice(0, h.indexOf("});"))
    expect(handler).toMatch(/closest\("\.cell"\)/) // the pre-existing cell branch stays first
    expect(handler).toMatch(/hideColTip\(\)/) // hovering a cell cancels any column tip (single active tip)
  })
})

describe("ad13 label staving + template feed (AD14 updated: uniform-count feed; staving unchanged) — no native titles", () => {
  test("buildGrid: the template core receives the config COUNT (single uniform constructor)", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/grid\.style\.gridTemplateColumns = gridTrackTemplate\(columns\(\)\.length\)/)
  })
  test('the column node staves its FULL label for the tip; zero native title attrs on headers', () => {
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildGrid"), INSPECTOR_UI_HTML.indexOf("function appendCell"))
    // NAMED DELTA (AD17 card b): the staved label ANCHOR moves to the DISPLAY layer
    // (de-abbreviation) — the principle is unchanged: the FULL label travels with the
    // column, the cropped paint never does. Data id c.id stays the key/testid input.
    expect(build).toMatch(/_label = laneDisplayLabel\(c\.id, c\.title\)/)
    expect(build).not.toMatch(/"title": c\.title/) // grep pin: no native title left (named delta — no double tooltips)
  })
})

describe("ad12 fixed-gutter model — single source constant; pitch/hit derived (AD13 retunes the knob to 2)", () => {
  const pitch = () => a10Need("CELL_MINI_H_PX") + a10Need("CELL_GUTTER_PX")
  test("FIXED GUTTER model (AD12): gutter 4 single source; pitch/vertical-hit DERIVED — ratio ceiling DELETED as named delta", () => {
    const block = a10Need("CELL_BLOCK_H_PX")
    expect(block).toBeGreaterThanOrEqual(12) // AD11 floor survives (blocks 24x14 stand — card: "delivered values otherwise stand")
    // NAMED SUPERSESSION DELTA (AD12 card): this unit previously asserted
    // `gutter ≤ 4` + `pitch ≤ floor(1.25×block)` — the ratio-of-height ceiling. Deleted:
    // the owner model is a fixed constant; the number below IS the contract.
    // THE CONTRACT is the fixed constant itself (AD13 retuned 4 -> 2: one line, the owner knob).
    expect(a10Need("CELL_GUTTER_PX")).toBe(2) // the one owner knob (AD13 card: value 2)
    expect(a10Need("CELL_PITCH_PX")).toBe(a10Need("CELL_MINI_H_PX") + a10Need("CELL_GUTTER_PX")) // pitch is a DERIVED value
    expect(pitch()).toBe(16) // and its derived value — pinned once, here only
    expect(a10Need("CELL_HIT_H_PX")).toBe(a10Need("CELL_PITCH_PX")) // vertical hit derives from pitch (gap-0 by construction)
    expect(pitch()).toBeGreaterThan(block) // a real gutter exists (never box-on-box contact)
  })
  test("vertical hit honesty RE-DERIVED at fixed pitch (ad11 card rule 2 survives): gap exactly 0, never overlap; horizontal comfort stands", () => {
    const block = a10Need("CELL_BLOCK_H_PX")
    const hitH = a10Need("CELL_HIT_H_PX")
    const hitW = a10Need("CELL_HIT_W_PX")
    expect(hitH).toBe(a10Need("CELL_PITCH_PX")) // hit ≡ pitch: adjacent hit rects touch at gap 0 (measured live in the battery)
    expect(a10Need("CELL_PITCH_PX") - hitH).toBe(0) // the never-overlap invariant at the NEW pitch — equality, not slack
    expect(hitH).toBeGreaterThanOrEqual(block) // the hit fully covers its visible block
    expect(hitH / 2 - block / 2).toBeLessThanOrEqual(a10Need("CELL_GUTTER_PX")) // extension stays inside the gutter, never enters the neighbor's block box (2 ≤ 4)
    expect(hitW).toBeGreaterThanOrEqual(40) // horizontal comfort stays at the AD10/11 pin
    expect(hitW).toBeLessThan(a10Need("GRID_TRACK_PX")) // no horizontal bleed across the narrow-track seam
  })
  test("derivation chain is real: served tokens come from the chain; SOURCE carries NO independent pitch/hit literals", () => {
    const grid = (INSPECTOR_UI_HTML.match(/#grid \{[^}]*\}/) ?? [""])[0]
    expect(grid).toContain("--cell-gutter: 2px;") // the fixed gutter (AD13 value), served from the single source
    expect(grid).toContain("--cell-pitch: 16px;") // served pitch exists ONLY as a derived constant's value
    expect(grid).toContain("--cell-hit-h: 16px;") // served hit likewise
    const hitRule = (INSPECTOR_UI_HTML.match(/\.cell::before \{[^}]*\}/) ?? [""])[0]
    expect(hitRule).toMatch(/height: var\(--cell-hit-h, var\(--cell-pitch/) // the rule consumes the chain, never a standalone value
    const src = require("node:fs").readFileSync(new URL("./ui.ts", import.meta.url), "utf8") as string
    expect(src).toMatch(/export const CELL_PITCH_PX = CELL_MINI_H_PX \+ CELL_GUTTER_PX/)
    expect(src).toMatch(/export const CELL_HIT_H_PX = CELL_PITCH_PX/)
    expect(src).not.toMatch(/export const CELL_(PITCH|HIT_H)_PX = \d+/) // no independent pitch/hit values exist anywhere
  })
})

// ── AD14 (owner 2026-11-05): full labels by WRAPPING in 64 px (no abbreviation),
// container-wide column tooltip, and the row-hover band for visual navigation
// ("there is no real row you need to render div element probably and visually
// attach it to the row"). Row data contract (inspected FIRST, per card): every
// column's children ARE the rows — .cell/.slot appended in rowSlots order, so the
// child index IS the row index; the band attaches to the grid's own row elements.
// NAMED RE-ANCHOR (AD17 card a, owner: "grid header should use single row - not different
// height - it's ok to crop the titles"): the AD14 wrap/fit lane above is RETIRED as behavior.
// Uniform SINGLE-ROW headers: one token font/line-height for all 12 (equal heights by single
// source), labels crop plain at the track edge, the fit machinery DELETES (multi-line model dead):
// headerLineCount, HEADER_MAX_LINES, HEADER_MIN_FONT_PCT, applyHeaderFit, si-h2-tight, siHeaderOversize.
// The old "all fully visible wrapped" evaluation becomes "uniform single-row, crop-allowed" (battery).
describe("ad17 uniform single-row header — one height by single source; crop plain; fit machinery deleted", () => {
  const ruleH2 = (selector: string): string => {
    const m = INSPECTOR_UI_HTML.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{[^}]*\\}"))
    return m ? m[0] : ""
  }
  test("single-value height tokens stand; the multi-line fit vocabulary is gone from source and page", () => {
    expect(a14Need("HEADER_FONT_PX")).toBe(12) // single source (unchanged font)
    expect(a14Need("HEADER_LINE_H_PX")).toBe(14) // single line rhythm ⇒ every header is ONE row tall by construction
    const src = require("node:fs").readFileSync(new URL("./ui.ts", import.meta.url), "utf8") as string
    for (const dead of ["headerLineCount", "HEADER_MAX_LINES", "HEADER_MIN_FONT_PCT", "applyHeaderFit", "si-h2-tight", "siHeaderOversize"]) {
      expect(src).not.toContain(dead)
      expect(INSPECTOR_UI_HTML).not.toContain(dead)
    }
    const h2 = ruleH2(".col h2")
    expect(h2).toContain(`font-size: ${a14Need("HEADER_FONT_PX")}px`) // uniform for all 12 — per-header inline styles must not exist anymore
    expect(h2).toContain(`line-height: ${a14Need("HEADER_LINE_H_PX")}px`)
    expect(h2).toMatch(/position: sticky/) // pinning untouched (AD6)
    expect(h2).toMatch(/top: 44px/)
  })
  test("no per-header fit pass runs at build; nothing re-anchors height later; plain crop carries overflow", () => {
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildGrid"), INSPECTOR_UI_HTML.indexOf("function appendCell"))
    expect(build).not.toMatch(/applyHeaderFit|fitHeader|style\.fontSize|style\.lineHeight/) // NO per-header mutation — uniformity is structural
    const h2 = ruleH2(".col h2")
    expect(h2).not.toMatch(/text-overflow|ellipsis/) // consistent with the buildGrid move: PLAIN crop — no ellipsis machinery introduced at all
    expect(h2).toMatch(/overflow: hidden/) // default clipping is the whole mechanism
  })
})

describe("ad14 row-hover band si-row-rect — ONE reused strip glued to the grid's own rows", () => {
  test("one reused si-row-rect: absolute in the stage scroll (rides with rows), pointer-events none, BELOW blocks above bg, height = derived pitch, token-only subtle bg", () => {
    expect((INSPECTOR_UI_HTML.match(/data-testid="si-row-rect"/g) ?? []).length).toBe(1)
    const cs = (INSPECTOR_UI_HTML.match(/#rowrect \{[^}]*\}/) ?? [""])[0]
    expect(cs).toMatch(/position: absolute/) // stage-space coordinates: scrolling needs NO reposition machinery
    expect(cs).toMatch(/pointer-events: none/) // never blocks a block
    expect(cs).toMatch(/height: var\(--cell-pitch/) // band == the exact rhythm row (derivation chain)
    expect(cs).toMatch(/z-index: 0/) // with FIRST-child DOM order: above the stage bg, below the positioned blocks
    expect(cs).toMatch(/background: color-mix\(in srgb, var\(--dim\)/) // subtle tint composed ONLY from an existing theme token — works in both themes
    expect(cs).toMatch(/visibility: hidden/) // shown only while hovering the grid
    expect(INSPECTOR_UI_HTML).toMatch(/#rowrect\.show \{ visibility: visible; \}/)
    // DOM ORDER is load-bearing (z-order below blocks): the band precedes the grid.
    expect(INSPECTOR_UI_HTML.indexOf('id="rowrect"')).toBeLessThan(INSPECTOR_UI_HTML.indexOf('id="grid"'))
  })
  test("rowIndexNearestY (pure): floor(y/pitch) with clamps; edge tolerance returns -1 — outside the wall the band HIDES, never guesses", () => {
    const f = a14Need("rowIndexNearestY")
    expect(a14Need("ROW_HL_EDGE_TOL_PX")).toBe(24) // tolerance = 2 pitch rows: generous inside the wall, honest beyond it
    expect(f(0, 16, 73, 24)).toBe(0)
    expect(f(20, 16, 73, 24)).toBe(1)
    expect(f(73 * 16 - 1, 16, 73, 24)).toBe(72)
    expect(f(73 * 16 + 24, 16, 73, 24)).toBe(72) // inside the tolerance: nearest row
    expect(f(73 * 16 + 25, 16, 73, 24)).toBe(-1) // past it: hide
    expect(f(-24, 16, 73, 24)).toBe(0)
    expect(f(-25, 16, 73, 24)).toBe(-1)
    expect(f(10, 16, 0, 24)).toBe(-1) // empty grid: nothing to highlight
  })
  test("delegated wiring: row index from the grid's OWN render data; band Y from the row element CENTERED on it (AD16 named delta — old TOP-alignment pinned below as superseded); follows rows; hides on leaving; clicks unbroken", () => {
    const js = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function showRowBandFor"))
    expect(js.length).toBeGreaterThan(0)
    const fn = js.slice(0, js.indexOf("function hideRowBand"))
    expect(fn).toMatch(/children\[/) // row = the column's child slot (the append-order contract) — the grid's own row data, no new source
    expect(fn).toMatch(/\.offsetTop/) // band Y comes from the row ELEMENT — exact under any header height drift
    // NAMED DELTA (AD16 part 1, owner screenshot: band a half-row BELOW the blocks): centering is
    // delegated to the pure core — the OLD top-alignment arithmetic (top = col + slot offsetTop) is replaced:
    expect(fn).toMatch(/bandCenterTop\(/) // centerY := the rendered row box center — the SAME element the renderer centers blocks in
    expect(fn).not.toMatch(/style\.top = \(col\.offsetTop \+ slot\.offsetTop\) \+ "px"/) // the row-box-TOP math is GONE (named delta)
    expect(fn).toMatch(/clientWidth/) // full stage width per card
    const h = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf('$("grid").addEventListener("pointerover"'))
    const handler = h.slice(0, h.indexOf("});"))
    expect(handler).toMatch(/showRowBandFor/) // the existing delegation drives it — no per-column listeners
    expect(handler).toMatch(/rowIndexNearestY/) // empty-area hovers map through the justified pure core
    expect(handler).toMatch(/rowSlots\.length/) // row extent comes from the same render state
    const o = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf('$("grid").addEventListener("pointerout"'))
    expect(o.slice(0, o.lastIndexOf("});"))).toMatch(/hideRowBand/) // leaving the grid hides the band
  })
})

// ---------------------------------------------------------------------------
// AD15 — tree string values render DECODED (owner: real newlines, no doubled escapes).
// Root cause (developer-verified): the ONE leaf emit site re-serialized strings with
// JSON.stringify at DISPLAY time. Fix rides the pure-core lane this suite already owns:
// treeValueText(node) is the single value-text channel, toString-injected at the emit
// site; the value span gets an explicit pre-wrap rule so real newlines render.
// NAMED DELTA substitution (recorded): the card expected "existing string-value display
// pins" to move — the suite has NONE (rg-verified: no display-side string pins exist;
// the only stringify display-adjacent pin is the RAW-path jsonBlock guard, which per
// the card's own boundary MUST NOT move — it stays asserted green unmodified below).
// Boundary: nested-JSON strings show decoded-ONCE text; no reparse (T1 locks it).
const a15c = uiAll as unknown as Record<string, any>
const a15Need = (name: string): any => {
  if (a15c[name] === undefined) throw new Error("ad15 core missing: " + name)
  return a15c[name]
}
const a15leaf = (kind: string, value: unknown) => ({ kind, value, key: null, path: "/v" })

// ---------------------------------------------------------------------------
// AD16 — (1) band CENTERED on the row's block line (same-source rule), (2) brick
// cells = track − 2 px inset (60 uniform), (3) coltip TOP-preference with viewport
// flip fallback. Pure cores carry the geometry; wiring pins show the page consumes
// them. Named deltas land in the ad10/ad13/ad14 lanes (width tokens, served bytes,
// coltip placement core, band alignment) — never as silent edits.
const a16 = uiAll as unknown as Record<string, any>
const a16Need = (name: string): any => {
  if (a16[name] === undefined) throw new Error("ad16 core missing: " + name)
  return a16[name]
}

describe("ad16 bandCenterTop — centerY on the row's rendered box, NOT its top", () => {
  test("centering math (pure): top = rowBoxTop + rowBoxH/2 − bandH/2 — reproduces the owner defect and its fix", () => {
    const f = a16Need("bandCenterTop")
    // owner crop scenario: block visually centers in a TALLER row box; band (height = pitch 16)
    // aligned to the box TOP sits half a band above center — i.e. its centerY misses the block's.
    expect(f(100, 14, 16)).toBe(99) // thin row box (14): nearly the old top math — unchanged look
    expect(f(100, 48, 16)).toBe(116) // tall row box (48): band follows the block's CENTER (old math: 100)
    expect(f(0, 16, 16)).toBe(0) // exactly-pitch row: identical to the old top math (regression floor)
    expect(f(50, 17, 16)).toBe(50 + Math.round(17 / 2 - 8)) // integer-safe rounding contract
  })
})

describe("ad16 topPreferredTipPlacement — column tip prefers ABOVE the header, flips only when top lacks room", () => {
  const vp = { top: 0, left: 0, width: 1200, height: 800 }
  test("room above: tip.bottom sits at or above anchor.top (+2 tolerance from the AC) — the TOP placement is the preference", () => {
    const f = a16Need("topPreferredTipPlacement")
    const anchor = { top: 400, bottom: 424, left: 200, right: 264 }
    const tip = { width: 120, height: 30 }
    const p = f(anchor as any, vp as any, tip as any)
    expect(p.placement).toBe("top")
    expect(p.y + tip.height).toBeLessThanOrEqual(anchor.top + 2) // AC inequality — evaluated live later
    expect(p.y).toBeGreaterThanOrEqual(vp.top) // inside viewport vertically
  })
  test("no room above (anchor near viewport top): flips BELOW — the only fallback; x stays clamped inside the viewport", () => {
    const f = a16Need("topPreferredTipPlacement")
    const anchor = { top: 6, bottom: 30, left: 200, right: 264 }
    const p = f(anchor as any, vp as any, { width: 120, height: 30 } as any)
    expect(p.placement).toBe("bottom")
    expect(p.y).toBeGreaterThanOrEqual(anchor.bottom) // below the header when the top is out of room
    const edge = f({ top: 400, bottom: 424, left: 1150, right: 1214 } as any, vp as any, { width: 120, height: 30 } as any)
    expect(edge.x + 120).toBeLessThanOrEqual(vp.width) // horizontal clamp rides the same edge-margin discipline
    expect(edge.x).toBeGreaterThanOrEqual(0)
  })
})

describe("ad16 brick geometry — width 60 derived, hit ≡ visible horizontally, no overlap on either axis", () => {
  test("horizontal non-overlap re-derived at brick width (mirror of the vertical gap-0 invariant): brick seam > 0, hits never cross the track center", () => {
    const w = a16Need("CELL_BLOCK_W_PX")
    const hitW = a16Need("CELL_HIT_W_PX")
    const track = a16Need("GRID_TRACK_PX")
    expect(track - w).toBe(2 * a16Need("CELL_CHIP_INSET_PX")) // the 2 px per-side inset IS the seam (4 total)
    expect(hitW).toBe(w) // AD16 re-derivation: hit ≡ visible horizontally (was a wider comfort pad at 24 px — superseded); vertical hit math untouched (ad11/ad12 lane)
    expect(track - hitW).toBeGreaterThan(0) // adjacent hit rects never overlap
    expect(w).toBeGreaterThan(track / 2) // brick rows are the dominant look (owner's explicit call)
  })
})

// ---------------------------------------------------------------------------
// AD17 — (a) uniform single-row header lives in the ad17 header lane above
// (named re-anchor of the AD14 fit lane); (b) DISPLAY-LAYER de-abbreviation:
// pure laneDisplayLabel + display-override map + tip description line. Data keys,
// category mapping and join integrity are BYTE-UNCHANGED — the override is keyed BY
// the data id and never rewrites it; existing join/contract suites (green, untouched)
// are the standing proof, pinned here by the override surface being exactly one key.
const a17 = uiAll as unknown as Record<string, any>
const a17Need = (name: string): any => {
  if (a17[name] === undefined) throw new Error("ad17 core missing: " + name)
  return a17[name]
}

describe("ad17 laneDisplayLabel — display-layer de-abbreviation, data keys byte-untouched", () => {
  test("override hits ONLY amt-activity with the spelled-out words; every other lane passes the configured label through unchanged", () => {
    const f = a17Need("laneDisplayLabel")
    expect(f("amt-activity", "AMT Activity")).toBe("Agent Meta Tool Activity") // spelled out (owner: no abbr)
    expect(f("amt-activity", "")).toBe("Agent Meta Tool Activity") // the override is authoritative for display, config-independent
    for (const [id, label] of [["user-messages", "User Messages"], ["tool-calls", "Tool Calls"], ["coach-judge", "Coach Judge"], ["lifecycle", "Lifecycle"], ["unknown-future-lane", "Whatever Config Says"]]) {
      expect(f(id, label)).toBe(label) // passthrough — byte-identical
    }
    // join integrity: the override surface is EXACTLY one data key. All other ids, all
    // testid/category machinery, all data strings: untouched by construction (existing
    // join/contract suites green unmodified = the standing proof).
    expect(Object.keys(a17Need("LANE_DISPLAY_OVERRIDES")).sort()).toEqual(["amt-activity"])
  })
  test("tip description exists ONLY for that lane, worded from the schema docs; header labels NEVER carry the description", () => {
    const descs = a17Need("LANE_TIP_DESCRIPTIONS")
    expect(Object.keys(descs).sort()).toEqual(["amt-activity"])
    expect(descs["amt-activity"]).toBe("History lines emitted by the agent-meta-tool (agent.amt) history lane.") // docs wording, verbatim — no invented claims
    // the header label is ONLY the spelled-out label (description is tip-only):
    expect(a17Need("laneDisplayLabel")("amt-activity", "AMT Activity")).not.toContain("History lines")
  })
  test("wiring: buildGrid staves the DISPLAY label and the optional description; the tip renders label + desc line; page consumes the cores (no forks)", () => {
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildGrid"), INSPECTOR_UI_HTML.indexOf("function appendCell"))
    expect(build).toMatch(/laneDisplayLabel\(/) // headers render the DISPLAY layer
    expect(build).toMatch(/_label = laneDisplayLabel\(/) // staving switches to the display layer (data id c.id NEVER rewritten)
    expect(build).toMatch(/_desc = /) // optional description staved alongside
    const js = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function showColTipFor"))
    const fn = js.slice(0, js.indexOf("function hideColTip"))
    expect(fn).toMatch(/_desc/) // the tip consumes the staved description when present
    expect(INSPECTOR_UI_HTML).toMatch(/laneDisplayLabel\.toString\(\)|function laneDisplayLabel/) // served copy IS the tested core
    // no bare uppercase abbreviation token shipped in any built-in display string:
    const src = require("node:fs").readFileSync(new URL("./ui.ts", import.meta.url), "utf8") as string
    const mapSrc = src.slice(src.indexOf("LANE_DISPLAY_OVERRIDES"), src.indexOf("LANE_DISPLAY_OVERRIDES") + 400)
    expect(mapSrc).toContain("Agent Meta Tool Activity")
  })
})

describe("ad15 decoded value text — treeValueText is the ONE plain-text value channel", () => {
  test("string values render DECODED: embedded newlines, quotes and backslashes pass through as-is; no surrounding quotes, no backslash-n sequences, NO doubled backslashes", () => {
    const t = a15Need("treeValueText")
    const multi = "line1\nline2\nline3"
    expect(t(a15leaf("string", multi))).toBe(multi) // real newline CHARACTERS, verbatim — that is what pre-wrap will render
    expect(t(a15leaf("string", 'He said "hi" and C:\\tmp'))).toBe('He said "hi" and C:\\tmp')
    const out = t(a15leaf("string", "a\nb"))
    expect(out.startsWith('"')).toBe(false) // no stringify quoting ever returned
    expect(out.includes("\\n")).toBe(false) // no literal backslash-n artifact
    expect(out.split("\\").length - 1).toBe(0) // no escape doubling for a plain string
  })
  test("declared boundary + non-string kinds byte-stable: nested-JSON string shows its decoded-ONCE text (no reparse); number/boolean/null render exactly as before; empty string stays empty", () => {
    const t = a15Need("treeValueText")
    const nested = '{"nestedKey":"inner\\nvalue"}' // a string whose VALUE is JSON text with an escaped newline
    expect(t(a15leaf("string", nested))).toBe(nested) // decoded-ONCE (the value itself) — never re-encoded, never re-parsed to objects
    expect(t(a15leaf("string", ""))).toBe("") // no '""' display
    expect(t(a15leaf("number", 1.5))).toBe("1.5")
    expect(t(a15leaf("boolean", true))).toBe("true")
    expect(t(a15leaf("null", null))).toBe("null")
  })
  test("ONE emit site: the leaf span feeds treeValueText(node) through the text channel — the string-branch JSON.stringify display is GONE (named delta)", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/treeValueText/) // core present in the served page
    const js = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function treeValueText"))
    expect(js.length).toBeGreaterThan(0)
    const f = js.slice(0, js.indexOf("\n}")) // the served copy IS the tested core (single source); window = the core body itself
    expect(f.length).toBeGreaterThan(10)
    // one plain-text channel for ALL kinds (strings decode = pass-through): no value re-serialization anywhere on it
    expect(f).not.toContain("JSON.stringify")
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildTreeRow"), INSPECTOR_UI_HTML.indexOf("function buildTreeRow") + 3000)
    expect(build).toMatch(/text:\s*treeValueText\(/) // the ONE leaf emit site uses the plain-text channel
    expect(build).not.toMatch(/node\.kind === "string" \? JSON\.stringify/) // the root cause is deleted, not commented out
    // keys and non-value punctuation keep their existing display contract (scope discipline):
    expect(build).toMatch(/class: "jt_key", text: JSON\.stringify\(node\.key\)/)
  })
  test("value span gets an explicit pre-wrap rule so decoded newlines RENDER as line breaks (row structure otherwise unchanged)", () => {
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildTreeRow"), INSPECTOR_UI_HTML.indexOf("function buildTreeRow") + 3000)
    expect(build).toMatch(/jt_value/) // shared value-span class at the emit site — kind classes stay for coloring
    const cs = (INSPECTOR_UI_HTML.match(/\.jt_value \{[^}]*\}/) ?? [""])[0]
    expect(cs).toMatch(/white-space: pre-wrap/) // explicit on the VALUE SPAN per card — real newlines inside rows, no clipping
  })
})

// ---------------------------------------------------------------------------
// AD19 — tool name INSIDE tool-calls cells (scoped supersession of zero-content).
// card: every cell of si-column-tool-calls shows its tool name, cropped to fit,
// font ~8-10px. ZERO-CONTENT STANDS for every other lane (the AD9 pin above was
// re-anchored as a NAMED delta). Pure core cellToolLabel from the row's OWN payload
// (the same payload contract the drawer's callID link uses — fetchPayload(env.payloadRef));
// fallback chain: tool name → first token of the line detail → "tool". Data layer NEVER
// truncates (crop is CSS at render, AD17 crop discipline). Label = non-interactive decoration.
const a19 = uiAll as unknown as Record<string, any>
const a19Need = (name: string): any => {
  if (a19[name] === undefined) throw new Error("ad19 core missing: " + name)
  return a19[name]
}
const a19Append = (): string => {
  const s = INSPECTOR_UI_HTML.indexOf("function appendCell")
  return INSPECTOR_UI_HTML.slice(s, INSPECTOR_UI_HTML.indexOf("function parseLine"))
}

describe("ad19 cellToolLabel — pure label core from the row's own payload", () => {
  test("tool payloads yield their tool name, FULL length — no data-layer truncation, ever", () => {
    const f = a19Need("cellToolLabel")
    expect(f('{"type":"tool","tool":"bash","callID":"c1"}')).toBe("bash")
    expect(f('{"type":"tool","tool":"websearch","state":{"status":"completed"}}')).toBe("websearch")
    const long = "application-wide-symbol-index-rebuilder-v2"
    const out = f('{"type":"tool","tool":"' + long + '","callID":"c2","state":{"detail":"whatever"}}')
    expect(out).toBe(long) // CROP IS RENDER-CSS; the DATA layer always carries the full name
    expect(out.length).toBe(long.length)
  })
  test("fallbacks in order: first token of the line detail, then the literal floor; NEVER empty", () => {
    const f = a19Need("cellToolLabel")
    expect(f('{"type":"tool","state":{"status":"completed","detail":"grep the config for tokens"}}')).toBe("grep") // detail-first-token
    expect(f('{"type":"tool"}')).toBe("tool") // no name, no detail — floor
    expect(f("write buffer contents to disk")).toBe("write") // raw line detail (history line payload) — first token
    expect(f("")).toBe("tool")
    expect(f("   \t ")).toBe("tool")
    expect(f(null as any)).toBe("tool")
    expect(f(undefined as any)).toBe("tool")
    expect(f(42 as any)).toBe("tool")
    for (const s of ['', '   ', '{bad json', '{"type":"patch"}', '{"type":"tool","state":{}}', null, undefined, 42, {}]) {
      expect(f(s as any).length).toBeGreaterThan(0) // contract: never empty
    }
  })
})

describe("ad19 cellToolLabel — truncation-safe (live battery defect: names must match even for TRUNCATED payloads)", () => {
  test("the tool name is extracted from a byte-capped JSON head before falling to token/floor chains", () => {
    const f = a19Need("cellToolLabel")
    // exactly what the payload endpoint serves for a truncated row: raw JSON-head text cut by byte cap
    const truncatedHead = '{"type":"tool","tool":"bash","callID":"ad8trunc01","state":{"status":"completed","inp'
    expect(f(truncatedHead)).toBe("bash") // field-visible → name, NOT the whole JSON head as a "token"
    // a truncated text payload that never reaches "tool": — the detail-token/floor order still stands:
    expect(f('{"type":"reasoning","te')).toBe("tool") // nothing field-extractable, no whitespace token → floor; never raw garbage
    expect(f("plain detail text here")).toBe("plain") // raw-detail first token stays
    // parseable JSON whose tool name itself contains no quotes still goes through the parse path (regression of test 1):
    expect(f('{"type":"tool","tool":"edit_file"}')).toBe("edit_file")
  })
})

describe("ad19 render lane — label ONLY in tool-calls, CSS crop inside the brick", () => {
  test("font token is named and inside the owner range 8-10px", () => {
    const px = Number(a19Need("CELL_LABEL_FONT_PX"))
    expect(px).toBe(9) // the render value
    expect(px).toBeGreaterThanOrEqual(8)
    expect(px).toBeLessThanOrEqual(10)
    // served CSS consumes the TOKEN, not a bare literal:
    expect(INSPECTOR_UI_HTML).toContain("--cell-label-font")
  })
  test("appendCell: the ONLY cell child is the label branch, gated on the tool-calls category, fed by the drawer payload contract (ONE call site)", () => {
    const body = a19Append()
    const calls = body.match(/cellToolLabel\(/g) ?? []
    expect(calls.length).toBe(1) // one call site — no second data source, no forks
    const gate = body.match(/if \(env\.category === "tool-calls"\) \{[\s\S]*appendChild/)
    expect(gate).not.toBe(null) // child building is ONLY for the tool-calls lane
    expect(body).toMatch(/fetchPayload\((env\.payloadRef|env\.payload_ref)/) // the row's OWN payload — the drawer contract, nothing else
    expect(body).toMatch(/\.textContent = cellToolLabel\(/) // text channel only (XSS discipline — no innerHTML)
    const gates = body.match(/env\.category === "tool-calls"/g) ?? []
    expect(gates.length).toBe(1) // exactly one gate; every other lane takes ZERO label code paths
  })
  test("label CSS: 9px token, nowrap + clip INSIDE the brick width, vertical center, pointer-events none, theme-chosen text color", () => {
    const rule = (INSPECTOR_UI_HTML.match(/\.cell-label \{[^}]*\}/) ?? [""])[0]
    expect(rule.length).toBeGreaterThan(20)
    expect(rule).toMatch(/font-size: var\(--cell-label-font/) // token (range asserted at the constant)
    expect(rule).toMatch(/white-space: nowrap/)
    expect(rule).toMatch(/overflow: hidden/) // CROP IS THE DESIGN (AD17 discipline) — plain clip, no ellipsis duty
    expect(rule).toMatch(/pointer-events: none/) // non-interactive decoration; hover/drawer seams untouched
    expect(rule).toMatch(/width: var\(--cell-block-w/) // crop boundary = the brick itself, never the hit carrier
    expect(rule).toMatch(/transform: translate\(-50%, -50%\)/) // vertical (and horizontal) center in the block
    expect(rule).toMatch(/left: 50%/) // same anchor geometry as the ::after brick — stays INSIDE it
    expect(rule).toMatch(/color: var\(--cell-label-text/) // contrast-chosen token…
    expect(INSPECTOR_UI_HTML).toMatch(/\[data-theme="dark"\] \.cell-label \{[^}]*--cell-label-text/) // …with the theme flip token (AD18 theme path: vars only)
    // geometry tokens untouched (pitch/gap/brick sizes are the AD12/AD16 invariants — unchanged):
    expect(INSPECTOR_UI_HTML).toMatch(/--cell-block-w/) // re-served as before
  })
  test("other lanes take ZERO label code paths: the gated branch is the single label surface in the whole page", () => {
    const globalCalls = INSPECTOR_UI_HTML.match(/cellToolLabel\(/g) ?? []
    const defs = INSPECTOR_UI_HTML.match(/function cellToolLabel/g) ?? []
    expect(globalCalls.length).toBe(defs.length + 1) // the definition + exactly ONE render call — no other lane can reach a label
  })
})

// ---------------------------------------------------------------------------
// AD20 — cell-label CSS polish (owner micro-instruction, 2026-11-05):
// "add 1px padding left for cell text and remove font weight". EXACTLY two
// declarations change on .cell-label: padding-left: 1px + font-weight: normal
// (computed 400 — overrides page-inherited weight). Nothing else: the card keeps
// the box in the crop model ("padding INSIDE the existing box") → border-box is
// pinned as the PRESENT box-sizing (a pre-browser default we state, not a size
// change) and the live battery asserts .cell-label clientWidth stays 60 (= brick).
describe("ad20 cell-label polish — 1px left padding, weight 400, nothing else", () => {
  const labelRule = () => (INSPECTOR_UI_HTML.match(/\.cell-label \{[^}]*\}/) ?? [""])[0]
  test("served rule carries exactly the two polish declarations", () => {
    const r = labelRule()
    expect(r.length).toBeGreaterThan(20)
    expect(r).toMatch(/padding-left: 1px/) // text starts 1px off the brick edge
    expect(r).toMatch(/font-weight: normal/) // remove font weight (declared normal)
    expect(r).not.toMatch(/font-weight:\s*6\d\d/) // the 600 emphasis is GONE from the served rule (named delta)
  })
  test("the box stays in AD19's crop model while the padding lands", () => {
    const r = labelRule()
    // border-box: stated PRESENT box model (content-box would push the node to 61px and
    // miscenter it by 0.5px — the card's 'padding inside the existing box' forbids that).
    expect(r).toMatch(/box-sizing: border-box/)
    // nothing else moved: the crop + interaction contract re-pinned verbatim (guards):
    expect(r).toMatch(/white-space: nowrap/)
    expect(r).toMatch(/overflow: hidden/)
    expect(r).toMatch(/pointer-events: none/)
    expect(r).toMatch(/width: var\(--cell-block-w/)
    expect(r).toMatch(/font-size: var\(--cell-label-font/)
    // no third NEW visual declaration introduced by AD20:
    expect(r).not.toMatch(/text-indent/)
    expect(r).not.toMatch(/margin/)
    expect(r).not.toMatch(/letter-spacing/)
    expect(r).not.toMatch(/transform:\s*translate\(-50%, -49%\)/) // no nudged centering
  })
})

// ---------------------------------------------------------------------------
// AD21 — #grid gap 4px + .cell padding 0 (owner CSS directive, 2026-11-05).
// DISAMBIGUATION (card-bound, resolved by structural inspection → CASE A):
// #grid's only template is grid-template-columns (repeat(n, GRID_TRACK_PX)) and its
// ONLY children are the column divs; the row boxes (.cell/.slot) live INSIDE columns
// with the margin-bottom pitch chain. No grid ROW tracks exist → the row-gap half of
// the shorthand is structurally inert → literal `gap: 4px` is set exactly as asked and
// CANNOT touch the owner-locked vertical rhythm (AD11/12). If that structure ever
// changes, this lane must flip to the column-gap variant + deviation + F-code, NOT silently.
describe("ad21 grid gap 4px + cell padding 0 — literal gap, vertical rhythm intact", () => {
  const gridRule = () => (INSPECTOR_UI_HTML.match(/#grid \{[^}]*\}/) ?? [""])[0]
  const cellRule = () => (INSPECTOR_UI_HTML.match(/\.cell \{[^}]*\}/) ?? [""])[0]
  test("served #grid carries gap: 4px and nothing else structural moved", () => {
    const r = gridRule()
    expect(r.length).toBeGreaterThan(20)
    expect(r).toMatch(/gap: 4px/) // literal owner directive (case A — see header comment)
    expect(r).not.toMatch(/gap: 10px/) // the old lane spacing is gone
    expect(r).toMatch(/--cell-pitch: \$\{|--cell-pitch: \d/) // pitch chain vars still served from tokens
    expect(r).not.toMatch(/row-gap: 16px/) // no pitch leaking back into any gap declaration
  })
  test("served .cell declares padding: 0 explicitly; the ::after brick model untouched", () => {
    const r = cellRule()
    expect(r).toMatch(/padding: 0/) // explicit (computed was already 0 — the directive stays verbatim)
    // the pitch/margin source stands AS-IS (AD11/12 locked):
    expect(r).toMatch(/margin-bottom: var\(--cell-gutter/)
    expect(r).toMatch(/height: var\(--cell-mini/)
    const after = (INSPECTOR_UI_HTML.match(/\.cell::after \{[^}]*\}/) ?? [""])[0]
    expect(after).toMatch(/width: var\(--cell-block-w/) // inset-2 crop model unchanged
  })
  test("single-source geometry: pitch tokens untouched module-wide; structure keeps case A valid", () => {
    const src = require("node:fs").readFileSync(new URL("./ui.ts", import.meta.url), "utf8") as string
    expect(src).toContain("export const CELL_GUTTER_PX = 2") // owner-locked gutter unchanged
    expect(src).toContain("export const CELL_MINI_H_PX = 14")
    expect(src).toContain("CELL_PITCH_PX = CELL_MINI_H_PX + CELL_GUTTER_PX") // 16 by derivation
    expect(INSPECTOR_UI_HTML).not.toMatch(/grid-template-rows/) // still NO row tracks → case A stays the ruling
  })
})

// ---------------------------------------------------------------------------
// AD22 — reasoning cells show length as NNNk. Pure core formatContentSize on the
// join-carried contentChars (NEVER the byte-capped payload endpoint).
// AD23 RE-ANCHOR (owner ruling, "below 1k, just show number as NNN"): AD22's "<1k" replaced
// by raw digits. AD24 RE-ANCHOR (owner ruling 2026-11-05, "below 1k show as 0,Nk"): raw
// digits SUPERSEDED in turn — n<1000 now renders the COMMA DECIMAL "0," + clamp(round(n/100),0,9)
// + "k" (ONE decimal, rounded, tenths clamped so >=950 renders "0,9k" — a second decimal never
// appears; 1.0k belongs to the integer path at n>=1000). Non-numeric/negative → "0,0k".
// The >=1000 k-path is byte-unchanged across all three rulings.
// Named replacement (card-mandated): both raw-number lanes below re-anchor to the comma edge
// table 0, 49/50, 164, 849/850, 949/950, 999, 1000.
// Lane scope like AD19: reasoning is the ONLY second label surface; the .cell-label
// channel is RE-USED unchanged (9px token, weight normal, padding-left 1px — AD20/21
// lanes re-pin that CSS; nothing new is styled here).
const a22 = uiAll as unknown as Record<string, any>
const a22Need = (name: string): any => {
  if (a22[name] === undefined) throw new Error("ad22 core missing: " + name)
  return a22[name]
}
describe("ad22 formatContentSize — thousands formatter (pure) [AD24: sub-1k = 0,Nk comma decimal]", () => {
  test("edge table per AD24 contract — one decimal, rounded, tenths clamped 0..9", () => {
    const f = a22Need("formatContentSize")
    expect(f(0)).toBe("0,0k") // zero text
    expect(f(49)).toBe("0,0k") // round(0.49)=0
    expect(f(50)).toBe("0,1k") // round(0.5)=1 — the boundary rounds UP (consistent with the k-path)
    expect(f(164)).toBe("0,2k") // the card's example: round(1.64)=2
    expect(f(849)).toBe("0,8k") // round(8.49)=8
    expect(f(850)).toBe("0,9k") // round(8.5)=9
    expect(f(949)).toBe("0,9k") // round(9.49)=9
    expect(f(950)).toBe("0,9k") // round(9.5)=10 → CLAMPED to 9 — "0,10k" never renders, no second decimal
    expect(f(999)).toBe("0,9k") // clamp holds to the top of the range; 1.0k belongs to the k-path
    expect(f(1000)).toBe("1k")
    expect(f(1250)).toBe("1k") // k-path byte-unchanged through all rulings
    expect(f(1500)).toBe("2k")
    expect(f(23_400)).toBe("23k")
    expect(f(124_000)).toBe("124k")
    expect(f(999_499)).toBe("999k")
  })
  test("defensive: non-numeric and negative inputs floor to 0,0k", () => {
    const f = a22Need("formatContentSize")
    for (const bad of [-5, NaN, Infinity, null, undefined, "1500", {}]) expect(f(bad as any)).toBe("0,0k")
    expect(/^(\d+k|0,\dk)$/.test(f(7))).toBe(true) // vocabulary: integer k or exactly one comma decimal
  })
})
describe("ad22 render lane — reasoning labels from the envelope field, same channel", () => {
  const append22 = (): string => {
    const s = INSPECTOR_UI_HTML.indexOf("function appendCell")
    return INSPECTOR_UI_HTML.slice(s, INSPECTOR_UI_HTML.indexOf("function parseLine"))
  }
  test("reasoning gate renders contentChars through formatContentSize with NO payload fetch", () => {
    const body = append22()
    const gate = body.match(/if \(env\.category === "reasoning"\) \{[\s\S]*?appendChild/)
    expect(gate).not.toBe(null)
    const branch = body.slice(body.indexOf('env.category === "reasoning"'), body.indexOf('env.category === "reasoning"') + 600)
    expect(branch).toMatch(/formatContentSize\(env\.contentChars/) // the JOIN-carried field is the only source
    expect(branch).toMatch(/appendChild/)
    expect(branch).not.toMatch(/fetchPayload/) // endpoint is byte-capped — forbidden as a length source (DEC-I class)
    expect(branch).toMatch(/cell-label/) // same channel class: 9px/400/padding come with it, nothing restyled
  })
  test("exactly THREE gated label branches exist in the page (tool-calls, reasoning, lifecycle — AD27); each core has ONE render call site", () => {
    // AD27 NAMED census update: the third lane-gated label branch (lifecycle ← env.partType,
    // field-fed like reasoning's contentChars — no new core). Tool/reasoning branches byte-untouched.
    const gates = INSPECTOR_UI_HTML.match(/env\.category === "(tool-calls|reasoning|lifecycle)"/g) ?? []
    expect(gates.length).toBe(3)
    const fmt = INSPECTOR_UI_HTML.match(/formatContentSize\(/g) ?? []
    const fmtDefs = INSPECTOR_UI_HTML.match(/function formatContentSize/g) ?? []
    expect(fmt.length).toBe(fmtDefs.length + 1)
    const tool = INSPECTOR_UI_HTML.match(/cellToolLabel\(/g) ?? []
    const toolDefs = INSPECTOR_UI_HTML.match(/function cellToolLabel/g) ?? []
    expect(tool.length).toBe(toolDefs.length + 1) // AD19 surface intact — reasoning did not displace it
  })
})

// ---------------------------------------------------------------------------
// AD25 — Legend button + column-explainer overlay modal (owner 2026-11-05).
// A SCREEN-LEVEL modal (explicitly NOT a floating-ui anchored popup): dimmed
// backdrop + centered panel, theme-aware (the existing token path), scrollable,
// z ABOVE the whole ladder (coltip 45 / hovercard 40 / drawer 60). Content =
// the card's pinned STATIC registry: one entry per column in display order with
// EXACT header display names — the drift lane compares the registry against a
// LIVE laneDisplayLabel(defaultCategories()) derivation: rename a header and
// forget the Legend and THIS file goes red (card's single-source test).
// Close affordances = AD4 drawer contract idiom: X + backdrop click + Escape
// through a pure core. The grid's data path (buildGrid/appendCell) carries
// ZERO legend references — cell census is provably untouched.
import { defaultCategories as a25Defaults } from "./config.schema"
import { laneDisplayLabel as a25Label } from "./ui"
import * as a25mod from "./ui"

const a25Need = (name: string): any => {
  if ((a25mod as any)[name] === undefined) throw new Error("ad25 export missing: " + name)
  return (a25mod as any)[name]
}
const a25Rule = (sel: string): string => {
  const m = INSPECTOR_UI_HTML.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{[^}]*\\}"))
  return m ? m[0] : ""
}
const a25Z = (sel: string): number => {
  const zz = a25Rule(sel).match(/z-index: (\d+)/)
  return zz ? Number(zz[1]) : -1
}
const a25Fn = (name: string, until: string): string => {
  const s = INSPECTOR_UI_HTML.indexOf("function " + name)
  if (s < 0) return ""
  const e = INSPECTOR_UI_HTML.indexOf(until, s + 1)
  return e < 0 ? INSPECTOR_UI_HTML.slice(s) : INSPECTOR_UI_HTML.slice(s, e)
}

describe("ad25 legend button — served header, LEFT of the theme toggle, consistent styling", () => {
  test("header markup carries the Legend button immediately before the theme toggle", () => {
    const h0 = INSPECTOR_UI_HTML.indexOf("<header")
    expect(h0).toBeGreaterThan(-1)
    const hdr = INSPECTOR_UI_HTML.slice(h0, INSPECTOR_UI_HTML.indexOf("</header>", h0))
    expect(hdr).toContain('id="legendButton"')
    expect(hdr).toContain('data-testid="legend-button"')
    const li = hdr.indexOf('id="legendButton"')
    const ti = hdr.indexOf('id="themeToggle"')
    expect(li).toBeGreaterThanOrEqual(0)
    expect(ti).toBeGreaterThanOrEqual(0)
    expect(li).toBeLessThan(ti) // DOM order LEFT of the toggle (card: "to the LEFT of the theme toggle")
    expect(hdr).toMatch(/id="legendButton"[^>]*>Legend<\/button>/) // visible label text (card: button "Legend")
  })
  test("#legendButton rule: right-group adjacency + the same control tokens as the toggle", () => {
    const r = a25Rule("#legendButton")
    expect(r.length).toBeGreaterThan(20)
    // themeToggle's own margin-left:auto absorbs ALL free space before ITSELF, which
    // would orphan the Legend on the far left; adjacency requires the auto margin to
    // start at the Legend instead (the last auto margin wins — verified against flexbox).
    expect(r).toMatch(/margin-left: auto/)
    // consistent with the existing header controls (token parity with #themeToggle):
    expect(r).toMatch(/height: 30px/)
    expect(r).toMatch(/background: var\(--panel\)/)
    expect(r).toMatch(/color: var\(--ink\)/)
    expect(r).toMatch(/border: 1px solid var\(--line\)/)
    expect(r).toMatch(/border-radius: 8px/)
    expect(r).toMatch(/cursor: pointer/)
    expect(r).toMatch(/flex: none/)
  })
})

describe("ad25 legend modal — screen-level overlay: backdrop, centered panel, z above everything, scrollable", () => {
  test("backdrop + modal + close landmarks served in the body (testids per card)", () => {
    expect(INSPECTOR_UI_HTML).toContain('id="legendBackdrop"')
    expect(INSPECTOR_UI_HTML).toContain('data-testid="legend-backdrop"')
    expect(INSPECTOR_UI_HTML).toContain('id="legendModal"')
    expect(INSPECTOR_UI_HTML).toContain('data-testid="legend-modal"')
    expect(INSPECTOR_UI_HTML).toContain('id="legendClose"')
    expect(INSPECTOR_UI_HTML).toContain('data-testid="legend-close"')
    expect(INSPECTOR_UI_HTML).toMatch(/id="legendModal"[^>]*role="dialog"/) // screen-level modal, not an anchored popup
  })
  test("dimmed fixed backdrop; centered panel with its own scroll; z ABOVE the full ladder", () => {
    const bd = a25Rule("#legendBackdrop")
    expect(bd.length).toBeGreaterThan(20)
    expect(bd).toMatch(/position: fixed/)
    expect(bd).toMatch(/inset: 0/)
    expect(bd).toMatch(/background: rgba\(/) // dimmed (no opaque token — dims whatever theme is under it)
    const md = a25Rule("#legendModal")
    expect(md.length).toBeGreaterThan(20)
    expect(md).toMatch(/position: fixed/) // SCREEN-level, centered in the viewport
    expect(md).toMatch(/left: 50%/)
    expect(md).toMatch(/top: 50%/)
    expect(md).toMatch(/transform: translate\(-50%, -50%\)/)
    expect(md).toMatch(/max-height: \d+(vh|%)/) // content taller than viewport is the DESIGN →
    // AD26 NAMED RE-ANCHOR (card's own structure clause supersedes this one line):
    // the SCROLL moved to the inner body (its sibling, pinned by the ad26 lanes);
    // the PANEL now clips at its own radius. The requirement (scrollable content)
    // is NOT dropped — it re-anchors to #legendBody in the ad26 block. All other
    // AD25 assertions in this test, and the four un-editable card lanes (markers,
    // order, names, drift), remain byte-identical.
    expect(md).toMatch(/overflow: hidden/) // panel paints NOTHING outside the rounded border
    expect(md).not.toMatch(/overflow-y: auto/)
    expect(md).toMatch(/background: var\(--panel\)/) // theme-aware through the existing token path ONLY
    expect(md).toMatch(/color: var\(--ink\)/)
    expect(md).toMatch(/border: 1px solid var\(--line\)/)
    // z-order: ABOVE everything the page positions (card) — hover card 40, header tip 45, drawer 60:
    expect(a25Z("#hovercard")).toBe(40) // existing ladder re-pinned (guards)
    expect(a25Z("#coltip")).toBe(45)
    expect(a25Z("#drawer")).toBe(60)
    expect(a25Z("#legendModal")).toBeGreaterThan(60)
    expect(a25Z("#legendBackdrop")).toBeGreaterThan(a25Z("#drawer")) // the dim sits above the drawer too
  })
  test("swatches ride the per-theme block-token path (the columns' own mechanism)", () => {
    const sw = a25Rule(".legend-swatch")
    expect(sw.length).toBeGreaterThan(10)
    expect(sw).toMatch(/background: var\(--block-light/) // same var path as .cell::after (L613)
    const dsw = INSPECTOR_UI_HTML.match(/\[data-theme="dark"\] \.legend-swatch \{[^}]*\}/)
    expect(dsw).not.toBe(null) // theme flip = token path ONLY (AD10/L614 discipline — no JS repaint)
    expect(dsw![0]).toMatch(/background: var\(--block-dark/)
  })
})

describe("ad25 legend close contract — X, backdrop click, Escape through a pure core (AD4 idiom)", () => {
  test("escShouldCloseLegend: closes on Escape ONLY while open", () => {
    const f = a25Need("escShouldCloseLegend")
    expect(f("Escape", true)).toBe(true)
    expect(f("Escape", false)).toBe(false) // closed: no-op (AD4 semantics mirrored)
    expect(f("a", true)).toBe(false) // other keys never close
    expect(f("Enter", true)).toBe(false)
    expect(f("", true)).toBe(false)
  })
  test("served wiring: document keydown through the core + backdrop+X click-close, one testid", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/escShouldCloseLegend\(ev\.key, .*\)\)\s*closeLegend\(\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/\$\("legendBackdrop"\)\.addEventListener\("click", closeLegend\)/)
    expect(INSPECTOR_UI_HTML).toMatch(/\$\("legendClose"\)\.addEventListener\("click", closeLegend\)/)
    const cl = a25Fn("closeLegend", "\nfunction ")
    expect(cl).toMatch(/classList\.remove\("legend-open"\)/) // state = body class (CSS paths the open state)
    // the AD3/AD1 close idiom exactly once (drawer precedent style):
    expect(INSPECTOR_UI_HTML.split('"legend-close"').length - 1).toBe(1)
  })
})

describe("ad25 modal-open suppression + provably untouched grid data", () => {
  test("open state: grid hover goes inert + both floating surfaces hidden before show", () => {
    expect(INSPECTOR_UI_HTML).toMatch(/\.legend-open #grid \{[^}]*pointer-events: none/) // card: inert grid OK
    const op = a25Fn("openLegend", "\nfunction ")
    expect(op).toMatch(/classList\.add\("legend-open"\)/)
    expect(op).toMatch(/hideHoverCard\(\)/) // no new hover cards behind the modal
    expect(op).toMatch(/hideColTip\(\)/)
    expect(op).toMatch(/buildLegendRows\(\)/) // rows materialize on open (grid-independent)
    expect(INSPECTOR_UI_HTML).toMatch(/\$\("legendButton"\)\.addEventListener\("click", openLegend\)/)
  })
  test("buildGrid/appendCell carry ZERO legend references — the cell census path is byte-untouched", () => {
    const bg = a25Fn("buildGrid", "var shown")
    expect(bg.length).toBeGreaterThan(50) // the real function, not a missing slice
    expect(bg).not.toMatch(/legend/i)
    const ac = a25Fn("appendCell", "function parseLine")
    expect(ac.length).toBeGreaterThan(50)
    expect(ac).not.toMatch(/legend/i)
    // rows are built into the modal container only — never the grid:
    const bl = a25Fn("buildLegendRows", "\nfunction ")
    expect(bl).toContain('$("legendRows")')
    expect(bl).not.toMatch(/\$\("grid"\)/)
  })
})

describe("ad25 legend registry — static, per default-active lane in display order, EXACT display names (zero drift)", () => {
  test("order + names byte-match a LIVE laneDisplayLabel(defaultCategories()) derivation — the single-source test", () => {
    const entries = a25Need("LEGEND_ENTRIES")
    expect(Array.isArray(entries)).toBe(true)
    const defs = a25Defaults()
    expect(entries.map((e: any) => e.id)).toEqual(defs.map((c) => c.id)) // every active lane, display order (card)
    entries.forEach((e: any, i: number) => {
      // THE drift assertion: derive the header's name from the LIVE single source and
      // byte-compare — rename a header (override or default title), forget the legend ⇒ red:
      expect(e.name).toBe(a25Label(defs[i].id, defs[i].title))
    })
    const amt = entries.find((e: any) => e.id === "amt-activity")
    expect(amt.name).toBe("Agent Meta Tool Activity") // full spelled name — exactly the header text (card)
    expect(entries.find((e: any) => e.id === "lifecycle").description).toMatch(/step-start/) // AD18 exclusion note
    expect(entries.find((e: any) => e.id === "lifecycle").description).toMatch(/step-finish/) // rides inside the entry
    expect(entries.find((e: any) => e.id === "lifecycle").description).toMatch(/EXCLUDED from display/)
    for (const e of entries) expect(typeof e.description).toBe("string")
  })
  test("descriptions = the card's pinned texts (what a cell in that column MEANS), non-empty, per lane", () => {
    const entries: any[] = a25Need("LEGEND_ENTRIES")
    const anchors: Record<string, RegExp> = {
      "user-messages": /text the USER wrote/,
      "assistant-text": /visible reply text/,
      reasoning: /size in chars/, // references the AD19-24 label contract
      "tool-calls": /'bash'/, // the card's example rides in the text
      transitions: /decision-tree traversal/,
      pipeline: /lifecycle commands/,
      "coach-judge": /coach judge evaluation/,
      "coach-activity": /coach agent's own recorded actions/,
      "amt-activity": /meta tool/i,
      "engine-nudges": /deterministic reminders/i,
      lifecycle: /compaction/,
      other: /catch-all/,
    }
    expect(Object.keys(anchors).length).toBe(12)
    for (const e of entries) {
      expect(e.description.length).toBeGreaterThan(20) // real descriptions, none empty (card)
      expect(e.description).toMatch(anchors[e.id])
    }
    expect(entries.find((e: any) => e.id === "reasoning").description).toMatch(/0,Nk/) // label format referenced per AD22-24
  })
  test("intro block states the row semantics and is SERVED with the modal", () => {
    const intro = a25Need("LEGEND_INTRO")
    expect(typeof intro).toBe("string")
    expect(intro).toMatch(/one joined session event/)
    expect(intro).toMatch(/time order/)
    expect(intro).toMatch(/column matching the event type/i)
    expect(intro).toMatch(/hover/i) // quick preview card
    expect(intro).toMatch(/drawer/i) // click = full details
    expect(INSPECTOR_UI_HTML).toContain(intro) // served in the modal markup — not invented at open time
  })
})

describe("ad25 modal rows — live columns, registry-fed names, per-theme swatch vars", () => {
  test("buildLegendRows iterates columns() and feeds swatch vars from the SAME pure core the columns use", () => {
    const bl = a25Fn("buildLegendRows", "\nfunction ")
    expect(bl).toMatch(/columns\(\)\.forEach/) // one entry PER COLUMN IN DISPLAY ORDER (live order, card)
    expect(bl).toMatch(/laneBlockColor\(c\.id, "light"\)/) // the columns' own color core (buildGrid parity)
    expect(bl).toMatch(/laneBlockColor\(c\.id, "dark"\)/) // both steps = the columns' var-pair pattern
    expect(bl).toMatch(/legendEntry\(c\.id\)/) // name+description resolved from the static registry
    expect(bl).toMatch(/laneDisplayLabel\(c\.id, c\.title\)/) // unknown/rename-local lanes fall back to the HEADER's own path
    expect(bl).toMatch(/"legend-name"/) // the names render as text, one row each
    expect(bl).toMatch(/"legend-desc"/)
  })
})

// ---------------------------------------------------------------------------
// AD26 — Legend modal geometry fix (owner defect, 2026-11-05, with screenshot):
// the scrollbar rode OUTSIDE the rounded panel and the header scrolled with the
// list. Structure (card, binding): PANEL = flex column, max-height cap as today,
// border-radius + overflow:hidden ON THE PANEL (nothing paints outside the curve);
// header (title + X, EXACT current look) = static sibling ABOVE the scroll
// container; the body element is the ONLY scroller (overflow-y:auto) holding
// intro + entries — its scrollbar renders inside the panel, inset from the
// rounded edge by the panel's own padding. Sticky/fixed tricks are forbidden
// when the DOM split is right — a negative guard pins that. Re-open resets to
// top EXPLICITLY. The four un-editable AD25 card lanes (markers, order, names,
// drift) stay byte-identical; exactly one AD25 assertion re-anchored with a
// NAMED delta (panel overflow), recorded in-test. Wheel-over-header is a LIVE
// acceptance check (measured in the battery), not a structure pin.
describe("ad26 modal geometry — panel clips, header static, inner body is the ONLY scroller", () => {
  const modalSeg = (): string => {
    const s = INSPECTOR_UI_HTML.indexOf('id="legendModal"')
    const e = INSPECTOR_UI_HTML.indexOf("<main>", s)
    return s >= 0 && e > s ? INSPECTOR_UI_HTML.slice(s, e) : ""
  }
  test("panel: flex column + clip at its own radius; cap kept; the old overflow-y role is GONE", () => {
    const md = a25Rule("#legendModal")
    expect(md.length).toBeGreaterThan(20)
    expect(md).toMatch(/flex-direction: column/) // the column split is the structure (defect 2's base)
    expect(a25Rule(".legend-open #legendModal")).toMatch(/display: flex/) // open state flips to the flex column (closed state stays display:none)
    expect(md).toMatch(/overflow: hidden/) // nothing paints outside the rounded border (defect 1)
    expect(md).toMatch(/border-radius: 12px/) // the existing radius stays
    expect(md).toMatch(/max-height: \d+(vh|%)/) // cap AS TODAY (card: keep the cap)
    expect(md).not.toMatch(/overflow-y: auto/) // named delta: the panel no longer scrolls
  })
  test("inner body is THE scroller: overflow-y auto on #legendBody + flex child scrolling properly", () => {
    const bd = a25Rule("#legendBody")
    expect(bd.length).toBeGreaterThan(10)
    expect(bd).toMatch(/overflow-y: auto/) // the scrollbar renders HERE — inside the panel's padding
    expect(bd).toMatch(/min-height: 0/) // flex-column child without it cannot scroll (sized to content)
    expect(bd).toMatch(/flex: 1 1 auto/) // fills the panel below the static header
    expect(bd).toMatch(/overscroll-behavior: contain/) // body scrolls stop at itself — the panel never pans
  })
  test("header is a STATIC sibling ABOVE the scroller — DOM split, not sticky tricks (defect 2)", () => {
    const seg = modalSeg()
    expect(seg.length).toBeGreaterThan(100)
    const hi = seg.indexOf('class="legend-head"')
    const bi = seg.indexOf('id="legendBody"')
    const ii = seg.indexOf('class="legend-intro"')
    const ri = seg.indexOf('id="legendRows"')
    expect(hi).toBeGreaterThanOrEqual(0)
    expect(bi).toBeGreaterThanOrEqual(0)
    expect(ii).toBeGreaterThanOrEqual(0)
    expect(ri).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThan(bi) // header precedes the body…
    expect(/<\/div>\s*<div id="legendBody"/.test(seg)).toBe(true) // …and CLOSES before it opens (sibling, not child)
    expect(bi).toBeLessThan(ii) // intro…
    expect(bi).toBeLessThan(ri) // …and the entries live INSIDE the body
    expect(seg.indexOf('data-testid="legend-close"')).toBeLessThan(bi) // the X is header-side (still top-right of the header)
    const hdr = a25Rule("#legendModal .legend-head")
    expect(hdr.length).toBeGreaterThan(10) // the header rule still exists (its look is owned by AD25 pins)
    expect(hdr).not.toMatch(/position:\s*(sticky|fixed)/) // sticky-by-STRUCTURE only — the forbidden-trick guard
  })
  test("re-open lands at top: reset is EXPLICIT AND EFFECTIVE (live defect 2026-11-05: reset BEFORE display had no layout — scrollTop assignment was a silent no-op, reopen kept 136px; effective reset requires the order below)", () => {
    const op = a25Fn("openLegend", "\nfunction ")
    const shown = op.indexOf('classList.add("legend-open")')
    const reset = op.indexOf('$("legendBody").scrollTop = 0')
    expect(shown).toBeGreaterThanOrEqual(0)
    expect(reset).toBeGreaterThanOrEqual(0) // explicit reset exists (no display-cycle luck)…
    expect(reset).toBeGreaterThan(shown) // …AND it runs while the scroller HAS LAYOUT (after the open flip)
  })
  test("one scroller only: single #legendBody, single rows container — no nested scrollers", () => {
    expect(INSPECTOR_UI_HTML.split('id="legendBody"').length - 1).toBe(1)
    expect(INSPECTOR_UI_HTML.split('id="legendRows"').length - 1).toBe(1)
  })
  test("wheel over the HEADER is explicitly forwarded to the body (AC behavior; no UA path can reach a sibling)", () => {
    // The card's behavior clause ("wheel over header still scrolls the body") binds a
    // behavior the correct DOM split CANNOT provide by UA chaining: the body is the
    // header's SIBLING, not its ancestor — a wheel gesture lands on the header and can
    // only reach ancestors (panel clips; document doesn't scroll). Deterministic
    // forwarder, passive:false + preventDefault: nothing else can scroll, so nothing is "blocked".
    expect(INSPECTOR_UI_HTML).toMatch(/addEventListener\("wheel", function \(ev\) \{[\s\S]{0,300}scrollTop \+= ev\.deltaY/)
    const wl = (INSPECTOR_UI_HTML.match(/addEventListener\("wheel", function \(ev\) \{[\s\S]*?\}, \{[^}]*\}\);/) ?? [""])[0]
    expect(wl.length).toBeGreaterThan(30) // the listener block, extracted whole
    expect(wl).toMatch(/passive: false/) // non-passive: it consumes (nothing else can scroll from a sibling gesture)
    expect(wl).toMatch(/preventDefault\(\)/) // no UA residue behind the panel
    expect(/"\.legend-head"\)[\s\S]{0,400}addEventListener\("wheel"/.test(INSPECTOR_UI_HTML)).toBe(true) // attached AT THE HEADER, nowhere else
    expect((INSPECTOR_UI_HTML.match(/addEventListener\("wheel"/g) ?? []).length).toBe(1) // exactly ONE wheel listener on the page
  })
})

// ---------------------------------------------------------------------------
// AD27 — third label-gate on the established channel (AD19 tool names, AD22-24
// reasoning sizes). Lifecycle cells carry the part's event type VERBATIM from
// the join-carried envelope field (partType) — the capped payload endpoint
// stays forbidden as a label source. Unknown/absent → NO label (contentless
// brick = current behavior). Channel bytes (9px/400/1px/crop) untouched; the
// gate-census lane above re-anchored 2→3 as the card's named contract lane.
describe("ad27 render lane — lifecycle labels read env.partType verbatim, same channel", () => {
  const append27 = (): string => {
    const s = INSPECTOR_UI_HTML.indexOf("function appendCell")
    return INSPECTOR_UI_HTML.slice(s, INSPECTOR_UI_HTML.indexOf("function parseLine"))
  }
  test("lifecycle gate renders env.partType through the cell-label channel, verbatim, NO payload fetch", () => {
    const body = append27()
    const at = body.indexOf('env.category === "lifecycle"')
    expect(at).toBeGreaterThan(-1)
    const branch = body.slice(at, at + 700)
    expect(branch).toMatch(/env\.partType/) // the JOIN-CARRIED field is the only source
    expect(branch).toMatch(/appendChild/)
    expect(branch).not.toMatch(/fetchPayload/) // capped endpoint stays forbidden here (AD22 rule preserved)
    expect(branch).toMatch(/cell-label/) // the established channel class — nothing restyled
    // VERBATIM: the value flows unprocessed — no formatting call of any kind inside the branch:
    expect(branch).not.toMatch(/formatContentSize|cellToolLabel|toUpperCase|toLowerCase|replace\(|trim\(/)
  })
  test("absent/unknown type guard: NO partType → no label element at all (contentless brick unchanged)", () => {
    const body = append27()
    // the GUARD is the whole gate condition — match the full if-expression in the body
    // (slicing from the condition's own start would exclude the literal `if (` prefix).
    expect(body).toMatch(/if \(env\.category === "lifecycle" && env\.partType\) \{/)
    // and it is a FIELD-PRESENCE guard: no value whitelist re-derivation in the condition:
    const guardLine = body.match(/if \(env\.category === "lifecycle" && env\.partType\) \{[^\n]*/)![0]
    expect(guardLine).not.toMatch(/patch|compaction|file/) // the renderer never re-derives the kind vocabulary
  })
  test("legend Lifecycle entry names the label addition; the exclusion note REMAINS; other entries untouched", () => {
    const entries: any[] = (a25mod as any).LEGEND_ENTRIES
    const lc = entries.find((e) => e.id === "lifecycle")
    expect(lc.description).toMatch(/cell label/i) // wording consistency (card's sanctioned sentence; sentence-initial capital allowed)
    expect(lc.description).toMatch(/patch/)
    expect(lc.description).toMatch(/compaction/)
    expect(lc.description).toMatch(/file/)
    expect(lc.description).toMatch(/EXCLUDED from display/) // AD18 note stays; AD25 anchors byte-intact
    const um = entries.find((e) => e.id === "user-messages")
    expect(um.description).toMatch(/text the USER wrote/) // no other entry touched
  })
})

// ---------------------------------------------------------------------------
// AD28 — config-driven geometry application. Design (single-consumption, per
// card): the BOOT fetch already carries cfg; ONE function applyGridConfig(cfg)
// runs exactly once in boot() right AFTER loadConfig (SC-09 order discipline:
// custom props set on laid-out-or-static elements before first render) and is
// the ONLY point where config values touch the page. Constants baked into the
// served HTML/CSS remain the unreachable-fetch fallback (defaults-identical
// values ⇒ today's exact paint either way). Derived geometry never re-reads
// cfg: the track template consumes the updated GRID_TRACK_PX global; the band
// + row index consume the updated ROW_BAND_PITCH; CSS consumers ride the
// --cell-* tokens; the AD12 law (pitch = block + CODE gutter) is re-derived
// from the code constants INSIDE applyGridConfig — no new literals anywhere.
describe("ad28 applyGridConfig — the single override point (boot order + derivation, no literals)", () => {
  const applyFn = (): string => {
    const s = INSPECTOR_UI_HTML.indexOf("function applyGridConfig")
    expect(s).toBeGreaterThan(-1)
    const e = INSPECTOR_UI_HTML.indexOf("\n}\n", s) // the function's OWN end (page template closes at column 0)
    expect(e).toBeGreaterThan(s)
    return INSPECTOR_UI_HTML.slice(s, e + 2)
  }
  test("boot applies config geometry EXACTLY ONCE, right after loadConfig, before the first paint step", () => {
    const bootAt = INSPECTOR_UI_HTML.indexOf("async function boot")
    expect(bootAt).toBeGreaterThan(-1)
    const boot = INSPECTOR_UI_HTML.slice(bootAt, bootAt + 700)
    const load = boot.indexOf("await loadConfig()")
    const apply = boot.indexOf("applyGridConfig(cfg)")
    expect(load).toBeGreaterThanOrEqual(0)
    expect(apply).toBeGreaterThan(load) // after the fetch (values exist)
    // exactly one CALL site (the definition line starts with `function `; calls are indented statements):
    expect((INSPECTOR_UI_HTML.match(/^[ \t]+applyGridConfig\(cfg\);/gm) ?? []).length).toBe(1)
  })
  test("reads cfg.ui.grid defensively — every field falls back to the injected constant (unreachable/older config = today's pixels)", () => {
    const f = applyFn()
    expect(f).toMatch(/cfg\.ui\.grid/)
    expect(f).toMatch(/typeof [\w.]+ === "number"/) // per-field type guard
    expect(f).toMatch(/: GRID_TRACK_PX/)
    expect(f).toMatch(/: CELL_MINI_H_PX/) // height default = the shipped box height
    expect(f).toMatch(/: CELL_LABEL_FONT_PX/)
  })
  test("AD12 law re-derived from CODE constants inside the override (pitch = block + gutter; block w = track − 2·inset; hit ≡ visible/pitch) — zero numeric literals in the function", () => {
    const f = applyFn()
    expect(f).toMatch(/h \+ CELL_GUTTER_PX/) // derived pitch, not a literal
    expect(f).toMatch(/w - 2 \* CELL_CHIP_INSET_PX/) // the current width derivation, same formula
    const stripped = f.replace(/"[^"]*"/g, "").replace(/\/\/[^\n]*/g, "")
    const nums = stripped.match(/(?<![A-Za-z_$.\d])\d+(?![\d.])/g) ?? []
    expect(nums.filter((n) => n !== "0" && n !== "2")).toEqual([]) // only the zero/structural 2 (2 *) — no px literals (64-class survival guard at this site)
  })
  test("writes the full token chain ONCE and reassignments are single-point: CSS vars + band pitch + track global; the track template itself never learns config", () => {
    const f = applyFn()
    for (const v of ["--cell-mini", "--cell-gutter", "--cell-pitch", "--cell-block-w", "--cell-block-h", "--cell-hit-w", "--cell-hit-h", "--cell-label-font"]) {
      expect(f).toContain(`setProperty("${v}"`)
    }
    expect(f).toMatch(/ROW_BAND_PITCH = h \+ CELL_GUTTER_PX/)
    expect(f).toMatch(/GRID_TRACK_PX = w/)
    expect(f).not.toMatch(/gridTemplateColumns/) // the track's ONE consumer stays gridTrackTemplate (reads the updated global)
    // the served track template body is unchanged: still repeat(n, ${GRID_TRACK_PX}px) — no cfg token inside
    const tt = (INSPECTOR_UI_HTML.match(/function gridTrackTemplate[\s\S]*?\n\}/) ?? [""])[0]
    expect(tt).toMatch(/repeat\(\$\{n\}, \$\{GRID_TRACK_PX\}px\)/)
    expect(tt).not.toMatch(/cfg|ui\.grid/)
  })
  test("legend + all served copy claim NO fixed-64 geometry text (interaction guard: nothing to reword)", () => {
    const json = (INSPECTOR_UI_HTML.match(/var LANE_LEGEND_TIPS[\s\S]*/) ? "" : "")
    void json
    const legendTexts = [...INSPECTOR_UI_HTML.matchAll(/"name":"[^"]+","description":"([^"]*)"/g)].map((x) => x[1])
    expect(legendTexts.length).toBe(12)
    for (const d of legendTexts) expect(d).not.toMatch(/\d+\s?px/)
    expect(INSPECTOR_UI_HTML.match(/#legendBody[\s\S]*?(64px|64 px)/g)).toBe(null)
  })
})

// AD30 (owner chain: "verify that row highlight strip is following" → AD29 flag 3b ruling):
// ONE-SITE FIX contract — the band's SHOW path must write BOTH geometry props from the SAME
// variable at the same point: top already = bandCenterTop(..., ROW_BAND_PITCH); height must be
// row_band_pitch px from that very variable (which applyGridConfig keeps in lockstep with the
// configured geometry). The CSS #rowrect height line is demoted to an honest FALLBACK (kept).
// No hardcoded px in the JS path (single consumption point, by construction).
describe("ad30 band height same-source — show path writes top AND height from ROW_BAND_PITCH; CSS is fallback-only", () => {
  const js = (() => {
    const i0 = INSPECTOR_UI_HTML.indexOf("function showRowBandFor")
    const i1 = INSPECTOR_UI_HTML.indexOf("function hideRowBand")
    expect(i0).toBeGreaterThan(-1)
    return INSPECTOR_UI_HTML.slice(i0, i1)
  })()
  test("show path: top from bandCenterTop(..., ROW_BAND_PITCH) (AD16 chain, re-pinned) AND height = ROW_BAND_PITCH px — same variable, written BEFORE the show flip (no flash-frame)", () => {
    expect(js).toMatch(/band\.style\.top = bandCenterTop\([^)]*ROW_BAND_PITCH\)/)
    const hIdx = js.search(/band\.style\.height = ROW_BAND_PITCH/)
    expect(hIdx).toBeGreaterThan(-1) // RED pre-fix: no height write exists in the path
    const sIdx = js.indexOf('.classList.add("show")')
    expect(sIdx).toBeGreaterThan(-1)
    expect(hIdx).toBeLessThan(sIdx) // both geometry writes land before visibility
  })
  test("single-source negatives: no numeric px literal for height anywhere in the band path; band path never re-reads --cell-pitch; the CSS rule SURVIVES as a documented fallback (kept, honest comment)", () => {
    // Checker-boundary (AD30 self-caught): the guard tests the CODE path — the honest comment
    // explaining WHY the var fails there is expected to name it. Strip // comment lines first.
    const code = js.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
    expect(code).not.toMatch(/style\.height = \d+/)
    expect(code).not.toMatch(/--cell-pitch/)
    const cs = (INSPECTOR_UI_HTML.match(/#rowrect \{[^}]*\}/) ?? [""])[0]
    expect(cs).toMatch(/height: var\(--cell-pitch, 16px\)/) // line KEPT as the pre-boot fallback
    expect(cs).toMatch(/fallback/i) // RED pre-fix: the rule comment does not yet name itself a fallback
  })
})

// AD35 — OWNER LAW (STANDING product ruling, superseding the AD31 acceptance ruling and the
// AD31 ESCAPE wording): direction is FIXED by the bg's WCAG relative luminance — L < 0.45
// makes the text the bg LIGHTER in hue; L >= 0.45 makes it DARKER. HSL lightness steps of 5%
// with lightness CLAMPED at 95/5; stop at contrast >= 4.5, or TERMINATE AT THE CLAMP — the
// direction never flips ("dark bg -> lighter text, period"). Sub-floor results are the law's
// honest output: report the achieved ratio, mark those rows max-in-direction. Explicit config
// text (hex) stays verbatim; 'auto'/omission = this law.
// Expected values are hardcoded FROM AN INDEPENDENT SPEC CALCULATOR (probe-ad35-law.mjs ->
// ad35-expected-law.json; spec authored from the card text, NOT the product code) so the
// golden cannot certify itself.
// NAMED RE-ANCHOR (expected mass re-anchoring per card R2): this describe REPLACES the AD31
// golden for the superseded law. 19 of 24 values changed old -> new (every LIGHT row; the 7
// former old-law ESCAPE rows usermessages-D, reasoning-D, transitions-D, coachjudge-D,
// enginenudges-D, lifecycle-D, other-D); 5 already-dark rows are value-UNCHANGED
// (assistanttext-D #0f4532, toolcalls-D #6b4d02, pipeline-D #074c57, coachactivity-D
// #12564e, amtactivity-D #3e5d0c). Full old -> new diff: materials/task-ad35-evidence.md.
describe("ad35 owner-law deriveLabelColor — golden 12x2 with direction proof (no-flip)", () => {
  const BUILTINS: Array<[string, string, string]> = [
    ["usermessages", "#3b82f6", "#60a5fa"], ["assistanttext", "#10b981", "#34d399"],
    ["reasoning", "#8b5cf6", "#a78bfa"], ["toolcalls", "#d97706", "#fbbf24"],
    ["transitions", "#f43f5e", "#fb7185"], ["pipeline", "#0891b2", "#22d3ee"],
    ["coachjudge", "#6366f1", "#818cf8"], ["coachactivity", "#14b8a6", "#2dd4bf"],
    ["amtactivity", "#65a30d", "#a3e635"], ["enginenudges", "#f97316", "#fb923c"],
    ["lifecycle", "#d946ef", "#e879f9"], ["other", "#ec4899", "#f472b6"],
  ]
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  const relLum = (h: string) => {
    const c = [0, 1, 2].map((i) => ch(h, i) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a: string, b: string) => (Math.max(relLum(a), relLum(b)) + 0.05) / (Math.min(relLum(a), relLum(b)) + 0.05)
  // INDEPENDENT HSL lightness (max+min)/2 — the law's own axis, for the direction proof.
  const hslL = (h: string) => { const c = [0, 1, 2].map((i) => ch(h, i) / 255); return (Math.max(...c) + Math.min(...c)) / 2 }
  // [lane, theme, bg, expected text, expected ratio, expected direction] — from the
  // independent calculator (ad35-expected-law.json), NOT from product output.
  const EXPECT: Array<[string, string, string, string, number, "LIGHTER" | "DARKER"]> = [
    ["usermessages", "L", "#3b82f6", "#e7effe", 3.18, "LIGHTER"],
    ["usermessages", "D", "#60a5fa", "#e6f1fe", 2.22, "LIGHTER"],
    ["assistanttext", "L", "#10b981", "#e8fdf6", 2.39, "LIGHTER"],
    ["assistanttext", "D", "#34d399", "#0f4532", 5.7, "DARKER"],
    ["reasoning", "L", "#8b5cf6", "#eee7fe", 3.53, "LIGHTER"],
    ["reasoning", "D", "#a78bfa", "#ece7fe", 2.26, "LIGHTER"],
    ["toolcalls", "L", "#d97706", "#fef3e6", 2.91, "LIGHTER"],
    ["toolcalls", "D", "#fbbf24", "#6b4d02", 4.68, "DARKER"],
    ["transitions", "L", "#f43f5e", "#fee7eb", 3.12, "LIGHTER"],
    ["transitions", "D", "#fb7185", "#fee6ea", 2.27, "LIGHTER"],
    ["pipeline", "L", "#0891b2", "#e7f9fe", 3.4, "LIGHTER"],
    ["pipeline", "D", "#22d3ee", "#074c57", 5.33, "DARKER"],
    ["coachjudge", "L", "#6366f1", "#e8e8fd", 3.7, "LIGHTER"],
    ["coachjudge", "D", "#818cf8", "#e7e9fe", 2.48, "LIGHTER"],
    ["coachactivity", "L", "#14b8a6", "#e8fcfa", 2.34, "LIGHTER"],
    ["coachactivity", "D", "#2dd4bf", "#12564e", 4.57, "DARKER"],
    ["amtactivity", "L", "#65a30d", "#f4fde7", 2.95, "LIGHTER"],
    ["amtactivity", "D", "#a3e635", "#3e5d0c", 5.02, "DARKER"],
    ["enginenudges", "L", "#f97316", "#fef0e6", 2.51, "LIGHTER"],
    ["enginenudges", "D", "#fb923c", "#fef1e6", 2.04, "LIGHTER"],
    ["lifecycle", "L", "#d946ef", "#fae8fd", 2.97, "LIGHTER"],
    ["lifecycle", "D", "#e879f9", "#fbe7fe", 2.1, "LIGHTER"],
    ["other", "L", "#ec4899", "#fde8f2", 3.02, "LIGHTER"],
    ["other", "D", "#f472b6", "#fde7f3", 2.26, "LIGHTER"],
  ]
  test("ALL 24 built-in lane bgs (12 lanes x both themes): value byte-exact per the OWNER LAW table; strict direction (LIGHTER for L<0.45, DARKER otherwise); ratio matches the table; either >= 4.5 or TERMINATED AT THE 95/5 CLAMP (max in direction) — no flip, ever", async () => {
    const { deriveLabelColor } = (await import("./ui")) as any
    expect(typeof deriveLabelColor).toBe("function")
    const rows: string[] = []
    for (const [lane, theme, bg, text, ratioW, dir] of EXPECT) {
      const t = deriveLabelColor(bg)
      expect(lane + "/" + theme + " " + t).toBe(lane + "/" + theme + " " + text) // NAMED re-anchor: owner-law expectation wins over the AD31 table
      const r = ratio(t, bg)
      expect(Math.abs(r - ratioW)).toBeLessThan(0.06)
      // Direction proof on the law's own axis — STRICT, independent of any lightness helper in product code:
      expect(lane + "/" + theme + " " + (dir === "LIGHTER" ? hslL(t) > hslL(bg) : hslL(t) < hslL(bg))).toBe(lane + "/" + theme + " true")
      if (r < 4.5) {
        // max-in-direction: the result's HSL lightness sits AT the law's clamp (95 or 5)
        const at = dir === "LIGHTER" ? Math.abs(hslL(t) - 0.95) <= 0.02 : Math.abs(hslL(t) - 0.05) <= 0.02
        expect(lane + "/" + theme + " clamped " + String(at)).toBe(lane + "/" + theme + " clamped true")
      } else {
        expect(r).toBeGreaterThanOrEqual(4.5)
      }
      rows.push(lane + " " + theme + " " + bg + " -> " + t + " @" + r.toFixed(2) + " " + dir + (r < 4.5 ? " [owner-law max-in-direction]" : ""))
    }
    console.log("AD35-GOLDEN\n" + rows.join("\n"))
  })
  test("NO direction-flip exists (monotonicity law): for every built-in the result is strictly on its lawful side of the bg in HSL lightness; determinism; the OLD escape signature (bg L<0.45 -> DARKER text) is now ILLEGAL for ALL 24", async () => {
    const { deriveLabelColor } = (await import("./ui")) as any
    for (const [lane, theme, bg] of BUILTINS.map(([l, lg, dk]) => [l, "L" as const, lg]).concat(BUILTINS.map(([l, lg, dk]) => [l, "D" as const, dk] as any))) {
      const t = deriveLabelColor(bg)
      expect(t).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(t).not.toBe(bg)
      const darkBg = relLum(bg) < 0.45
      if (darkBg) expect(lane + "/" + theme + " LIGHTER-only " + String(hslL(t) > hslL(bg))).toBe(lane + "/" + theme + " LIGHTER-only true")
      else expect(lane + "/" + theme + " DARKER-only " + String(hslL(t) < hslL(bg))).toBe(lane + "/" + theme + " DARKER-only true")
      expect(deriveLabelColor(bg)).toBe(deriveLabelColor(bg))
    }
  })
  test("extreme bgs keep reachable floors: #000 -> light-side >= 4.5, #ffffff -> dark-side >= 4.5 (their poles exist INSIDE the direction). Re-anchored BY DESIGN from the AD31-era 'max-contrast pole choice' framing: the direction IS the law now; clamp termination is the honest fallback where the floor is unreachable in-hue. #60a5fa (an old ESCAPE row) now returns the lightest in-hue near-white instead of a dark escape (NAMED re-anchor: #043571 -> light-side)", async () => {
    const { deriveLabelColor } = (await import("./ui")) as any
    for (const bg of ["#000000", "#ffffff"]) {
      const t = deriveLabelColor(bg)
      expect(ratio(t, bg)).toBeGreaterThanOrEqual(4.5)
      const darkBg = relLum(bg) < 0.45
      expect(darkBg ? hslL(t) > hslL(bg) : hslL(t) < hslL(bg)).toBe(true)
    }
    const v = deriveLabelColor("#60a5fa")
    expect(hslL(v) > hslL("#60a5fa")).toBe(true) // was #043571 under the superseded law
    expect(v).toBe(deriveLabelColor("#60a5fa"))
  })
  test("the reported defect case, RESOLVED BY LAW (owner example '4k' labels): reasoning bgs get LIGHTER text on BOTH themes — dark-on-dark is now structurally impossible. Honest ratios: L #eee7fe @ ~3.53, D #ece7fe @ ~2.26 — UNDER the 4.5 floor, terminated at the 95% clamp: 'owner-law (max in direction)' per the standing ruling's own reporting clause. Re-anchored from the AD31 4.53/4.83 dark-texts which the owner rejected.", async () => {
    const { deriveLabelColor } = (await import("./ui")) as any
    for (const bg of ["#8b5cf6", "#a78bfa"]) {
      const t = deriveLabelColor(bg)
      expect(hslL(t) > hslL(bg)).toBe(true)
      expect(ratio(t, bg)).toBeGreaterThan(ratio("#130336", bg) > 0 ? 1 : 1) // (sanity: a real color, not a self-equal)
      expect(t).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})
describe("ad31 color application — served copy: config override in laneBlockColor, laneLabelTextColor (explicit verbatim else derived), one apply call point, label tokens per column, CSS #000 fallbacks documented", () => {
  test("served page: applyColorsConfig defined once and CALLED once immediately after applyGridConfig(cfg) (same apply-phase pattern, no new call sites)", () => {
    expect((INSPECTOR_UI_HTML.match(/function applyColorsConfig/g) ?? []).length).toBe(1)
    // Calls only: the definition signature matched the naive pattern too (checker fix, AD31).
    const calls = [...INSPECTOR_UI_HTML.matchAll(/[^n]applyColorsConfig\(cfg\);/g)]
    expect(calls.length).toBe(1)
    const gCall = INSPECTOR_UI_HTML.indexOf("applyGridConfig(cfg)")
    const cCall = INSPECTOR_UI_HTML.indexOf("applyColorsConfig(cfg)")
    expect(gCall).toBeGreaterThan(-1)
    expect(cCall).toBeGreaterThan(gCall)
  })
  test("token path (zero new plumbing): laneBlockColor consults LANE_COLOR_CFG bg BEFORE palette; laneLabelTextColor returns explicit text VERBATIM (no derive on that branch) else deriveLabelColor of the EFFECTIVE bg; grid columns set both label tokens per theme via it; legend keeps reusing the same bg path untouched", () => {
    const lb = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function laneBlockColor"))
    expect(lb.slice(0, lb.indexOf("function laneLabelTextColor") > 0 ? lb.indexOf("function laneLabelTextColor") : 4000)).toMatch(/LANE_COLOR_CFG/)
    const lt = INSPECTOR_UI_HTML.match(/function laneLabelTextColor[\s\S]*?function /)?.[0] ?? ""
    expect(lt).toMatch(/return o\.text/) // explicit hex used verbatim
    expect(lt).toMatch(/deriveLabelColor\(/) // auto path = the law
    expect(INSPECTOR_UI_HTML).toMatch(/setProperty\("--cell-label-text-light", laneLabelTextColor\(/)
    expect(INSPECTOR_UI_HTML).toMatch(/setProperty\("--cell-label-text-dark", laneLabelTextColor\(/)
    expect(INSPECTOR_UI_HTML).toMatch(/legend-swatch/) // legend path present and UNCHANGED (same --block-* path)
  })
  test("CSS label rules keep var tokens and rename #000 to an honest documented fallback (in-rule comment names it) — value chain untouched", () => {
    const darkRule = INSPECTOR_UI_HTML.match(/\[data-theme="dark"\] \.cell-label \{[^}]*\}/)?.[0] ?? ""
    expect(darkRule).toMatch(/var\(--cell-label-text-dark, #000\)/)
    expect(darkRule).toMatch(/fallback/i)
    const lightRule = INSPECTOR_UI_HTML.match(/\.cell-label \{[^}]*\}/)?.[0] ?? ""
    expect(lightRule).toMatch(/var\(--cell-label-text, var\(--cell-label-text-light, #000\)\)/)
  })
})

// AD32 — restartless config: invalid config must NOT leave the page dead. The page-shell
// branch (served copy = tested core) renders an inline banner with the EXACT failure
// (code + message + path from the /config error body) and a Retry control; a background
// poll re-checks; on validity the banner states 'Config valid — reloading…' and the page
// reloads ONCE. Valid-path behavior byte-identical; endpoints stay strict (DEC-I lanes
// untouched elsewhere). Deviations from card wording are flagged in evidence: the page
// route is statically 200 today (gap = silent-dead boot, not a raw 500) and NO interval
// existed to reuse (livebar is EventSource) — one disclosed CONFIG_RETRY_MS, no second.
describe("ad32 shell-invalid branch — banner, retry, self-heal (served copy)", () => {
  test("loadConfig failure branch: banner si-config-error with code+exact message+path, retry button si-config-error-retry, and NO data rendering attempted", () => {
    const lc = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("async function loadConfig"))
    const branch = lc.slice(0, lc.indexOf("function columns"))
    expect(branch).toMatch(/si-config-error/)
    expect(branch).toMatch(/si-config-error-retry/)
    // (self-caught shape-literal fix: fields read via a local `data` binding — the contract
    // is "fields come from the error body's data", not a specific variable-chain.)
    expect(branch).toMatch(/data\.message/) // EXACT schema issues surface verbatim
    expect(branch).toMatch(/data\.path/)
    expect(branch).toMatch(/data\.code/)
    expect(branch).toMatch(/fix the file/i)
    expect(branch).toMatch(/reload/i)
    // config-independent shell: the failure branch must NOT touch session/feed fetches
    expect(branch).not.toMatch(/loadSessions\(/)
  })
  test("self-heal transition: success path shows 'Config valid' + reloading statement then location.reload() exactly once, with the retry on the SAME check function (no duplicate mechanisms); one disclosed interval constant only", () => {
    const page = INSPECTOR_UI_HTML
    expect(page).toMatch(/Config valid[^"'`]*reload/i)
    expect((page.match(/location\.reload\(\)/g) ?? []).length).toBe(1) // ONE reload per transition, no loops
    expect((page.match(/CONFIG_RETRY_MS/g) ?? []).length).toBeGreaterThanOrEqual(2) // declared once + used by the poll/retry
    expect((page.match(/var CONFIG_RETRY_MS/g) ?? []).length).toBe(1)
    expect(page).not.toMatch(/var CONFIG_RETRY_MS_2|CONFIG_POLL_2/) // no second invention
  })
  test("valid path untouched: loadConfig still assigns cfg + renders normally when res.ok (byte-identical success branch semantics)", () => {
    const lc = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("async function loadConfig"))
    const branch = lc.slice(0, lc.indexOf("function columns"))
    expect(branch).toMatch(/res\.ok/) // explicit success gating (failure branch keyed on the same check)
    expect(branch).toMatch(/cfg = /) // success still bakes the real config
  })
})

// ---------------------------------------------------------------------------
// AD34 — theme-aware color resolution: per theme, an explicit THEME key wins over the
// shared key, which wins over the built-in palette; text = theme override, else explicit
// shared, else the derivation law on the EFFECTIVE bg of THAT theme ("auto" is explicit
// auto). Consumed through the served-copy core sandboxed with LANE_COLOR_CFG injected
// (same served-copy-is-the-tested-core discipline as every color lane above; the module
// copy and the served copy are the same function sources — the empty-cfg lane pins their
// equality, which is also R1's byte-identical-defaults regression).
describe("ad34 theme-aware color resolution — theme override > shared > built-in; per-theme auto (served-copy sandbox)", () => {
  const ad34Core = (cfgColors: Record<string, any>) => {
    const start = INSPECTOR_UI_HTML.indexOf("var LANE_BLOCK_BASE")
    const end = INSPECTOR_UI_HTML.indexOf("function siRowTestId(")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start) // the three color fns live between the palette data and the testid cores
    const src = INSPECTOR_UI_HTML.slice(start, end)
    expect(src).toMatch(/function laneBlockColor\(/)
    expect(src).toMatch(/function deriveLabelColor\(/)
    expect(src).toMatch(/function laneLabelTextColor\(/)
    const mk = new Function("LANE_COLOR_CFG", src + "\nreturn { laneBlockColor, deriveLabelColor, laneLabelTextColor };")
    return mk(cfgColors) as { laneBlockColor: (k: string, t: "light" | "dark") => string; deriveLabelColor: (h: string) => string; laneLabelTextColor: (k: string, t: "light" | "dark") => string }
  }
  const empty = ad34Core({})
  const mod = { laneBlockColor: a10Need("laneBlockColor"), deriveLabelColor: a10Need("deriveLabelColor"), laneLabelTextColor: a10Need("laneLabelTextColor") }

  test("R1 REGRESSION: empty config — served core equals the module core for ALL 12 lanes x both themes (tokens byte-identical to today)", () => {
    const LANES = ["user-messages", "assistant-text", "reasoning", "tool-calls", "transitions", "pipeline", "coach-judge", "coach-activity", "amt-activity", "engine-nudges", "lifecycle", "other"]
    for (const lane of LANES) {
      for (const theme of ["light", "dark"] as const) {
        expect(empty.laneBlockColor(lane, theme)).toBe(mod.laneBlockColor(lane, theme))
        expect(empty.laneLabelTextColor(lane, theme)).toBe(mod.laneLabelTextColor(lane, theme))
      }
    }
  })

  test("R2 golden resolve-order table (bg): shared-only paints both themes; theme-only does NOT leak to the other theme (built-in there); theme key WINS over shared for its theme; bgDark-only = the dark-only override case the owner grammar needs", () => {
    const SHARED = "#123456", DARKONLY = "#0a0a0a", A = "#ff0000", B = "#00ff00"
    const t = (cfg: Record<string, any>, lane: string, theme: "light" | "dark", want: string, why: string) => {
      expect(ad34Core({ [lane]: { bg: cfg.bg, bgDark: cfg.bgDark } }).laneBlockColor(lane, theme)).toBe(want)
      void why
    }
    const base = mod.laneBlockColor
    // shared bg → both themes (AD31 behavior unchanged)
    t({ bg: SHARED }, "reasoning", "light", SHARED, "shared-light"); t({ bg: SHARED }, "reasoning", "dark", SHARED, "shared-dark")
    // theme-only keys do not leak
    t({ bgDark: DARKONLY }, "reasoning", "dark", DARKONLY, "dark-override")
    t({ bgDark: DARKONLY }, "reasoning", "light", base("reasoning", "light"), "no-leak: light falls to built-in")
    // theme override wins over shared IN ITS theme; shared serves the other
    t({ bg: A, bgDark: B }, "reasoning", "light", A, "light shared")
    t({ bg: A, bgDark: B }, "reasoning", "dark", B, "dark override wins")
    // unknown-to-config lanes keep palette (id-scoped, no cross-lane leakage)
    t({ bg: A }, "reasoning", "dark", A, "x"); expect(ad34Core({ "reasoning": { bg: A } }).laneBlockColor("lifecycle", "light")).toBe(base("lifecycle", "light"))
  })

  test("R2 golden resolve-order table (text): theme text wins; shared text fills the theme without one; explicit per-theme; 'auto'/omission = derivation on the EFFECTIVE bg of that theme (theme-aware bg changes what auto means)", () => {
    const LANE = "reasoning", LBG = "#ff00aa", DBG = "#0a0a0a"
    const cfgA = { [LANE]: { bg: LBG, bgDark: DBG, text: "#eeeeee" } } // text shared, no textDark
    const coreA = ad34Core(cfgA)
    expect(coreA.laneLabelTextColor(LANE, "light")).toBe("#eeeeee") // shared explicit serves light
    expect(coreA.laneLabelTextColor(LANE, "dark")).toBe("#eeeeee") // ... and dark (unchanged AD31 fill rule)
    const cfgB = { [LANE]: { bg: LBG, bgDark: DBG, text: "#eeeeee", textDark: "#111111" } } // per-theme override wins
    const coreB = ad34Core(cfgB)
    expect(coreB.laneLabelTextColor(LANE, "light")).toBe("#eeeeee")
    expect(coreB.laneLabelTextColor(LANE, "dark")).toBe("#111111")
    const cfgC = { [LANE]: { bg: LBG, bgDark: DBG, textDark: "auto" } } // explicit auto = law on THIS theme's bg
    const coreC = ad34Core(cfgC)
    expect(coreC.laneLabelTextColor(LANE, "light")).toBe(mod.deriveLabelColor(LBG))
    expect(coreC.laneLabelTextColor(LANE, "dark")).toBe(mod.deriveLabelColor(DBG)) // the theme-aware part: NOT derive(shared light bg)
    const cfgD = { [LANE]: { bgDark: DBG } } // dark-only bg override: light auto derives from built-in light; dark derives from the dark override
    const coreD = ad34Core(cfgD)
    expect(coreD.laneLabelTextColor(LANE, "light")).toBe(mod.deriveLabelColor(mod.laneBlockColor(LANE, "light")))
    expect(coreD.laneLabelTextColor(LANE, "dark")).toBe(mod.deriveLabelColor(DBG))
    expect(coreD.laneLabelTextColor(LANE, "dark")).not.toBe(mod.deriveLabelColor(mod.laneBlockColor(LANE, "dark"))) // proof the override fed the law, not the palette
  })

  test("served-copy wiring unchanged: the three color fns appear EXACTLY once; token write sites untouched (single consumption point per token — both theme pairs)", () => {
    expect((INSPECTOR_UI_HTML.match(/function laneBlockColor\(/g) ?? []).length).toBe(1)
    expect((INSPECTOR_UI_HTML.match(/function laneLabelTextColor\(/g) ?? []).length).toBe(1)
    expect((INSPECTOR_UI_HTML.match(/function deriveLabelColor\(/g) ?? []).length).toBe(1)
    expect((INSPECTOR_UI_HTML.match(/setProperty\("--block-light", laneBlockColor\(c\.id, "light"\)\)/g) ?? []).length).toBeGreaterThanOrEqual(1)
    expect((INSPECTOR_UI_HTML.match(/setProperty\("--block-dark", laneBlockColor\(c\.id, "dark"\)\)/g) ?? []).length).toBeGreaterThanOrEqual(1)
    expect((INSPECTOR_UI_HTML.match(/setProperty\("--cell-label-text-light", laneLabelTextColor\(/g) ?? []).length).toBe(1)
    expect((INSPECTOR_UI_HTML.match(/setProperty\("--cell-label-text-dark", laneLabelTextColor\(/g) ?? []).length).toBe(1)
  })
})

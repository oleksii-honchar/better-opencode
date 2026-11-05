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
  test("cells are CONTENTLESS: no ts text, no dots, no children — ts/lane ride attributes + aria-label only", () => {
    const cell = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("var cell = h(\"div\", { class: \"cell\""))
    const body = cell.slice(0, cell.indexOf("// AD7 placement"))
    expect(body).not.toMatch(/class: "cts"/) // ts text GONE (AD10) — attributes only
    expect(body).not.toMatch(/class: "dot/) // state dots GONE (F25 allowance superseded by the card)
    expect(body).toContain('"data-ts": env.ts') // ts stays addressable...
    expect(body).toMatch(/"aria-label": env\.ts/) // ...and reachable: aria-label = ts (a11y per card)
    expect(body).toContain('"data-category": env.category') // lane identity stays an attribute
    expect(body).not.toMatch(/appendChild/) // zero element children are ever built into a cell
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

  test("buildGrid paints lanes: per-column block vars (both themes), header WRAPS full labels (AD14 REPLACES the ellipsis model); native title stays removed", () => {
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildGrid"), INSPECTOR_UI_HTML.indexOf("function appendCell"))
    expect(build).toMatch(/setProperty\("--block-light", laneBlockColor\(c\.id, "light"\)\)/)
    expect(build).toMatch(/setProperty\("--block-dark", laneBlockColor\(c\.id, "dark"\)\)/)
    // NAMED SUPERSESSION (AD13 card c KEPT): native title remains removed — the real
    // tooltip surface (si-col-tip) is the full-label carrier next to the wrapped paint.
    expect(build).not.toMatch(/"title": c\.title/)
    // NAMED SUPERSESSION (AD14 card b): the AD10/AD13 ellipsis model (nowrap + clip +
    // text-overflow) is REPLACED — labels render FULL inside the 64 px track via
    // wrapping (owner: "don't use abbr - i don't get what it is").
    const h2 = rule1(".col h2")
    expect(h2).toMatch(/white-space: normal/)
    expect(h2).toMatch(/overflow-wrap/)
    expect(h2).not.toMatch(/text-overflow/)
    expect(h2).not.toMatch(/white-space: nowrap/)
    expect(h2).not.toMatch(/overflow: hidden/) // a clipped label is the abbreviation this card removes
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
    expect(fn).toMatch(/textContent/) // single text node = the full column label — no preview, no other content
    expect(fn).toMatch(/_label/) // label staved from the config title at build time (full text, never the elided paint)
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
    expect(build).toMatch(/_label = c\.title/) // full label travels with the column (the tooltip surface reads it)
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
describe("ad14 wrapped-header fit assist — declared ONE degradation step (90 %, once), never a silent ellipsis", () => {
  test("headerLineCount(height, lineHeight): honest line math used by the fit decision", () => {
    const f = a14Need("headerLineCount")
    expect(f(28, 14)).toBe(2)
    expect(f(42, 14)).toBe(3)
    expect(f(0, 14)).toBe(0)
    expect(f(34, 14)).toBe(2) // rounding is CONSERVATIVE toward the declared max: a 2.4-line box is 2 full lines of paint
    expect(a14Need("HEADER_LINE_H_PX")).toBe(14) // token: line-height 1.15 x the existing 12px header font (unchanged font, measured rhythm token)
    expect(a14Need("HEADER_MAX_LINES")).toBe(2) // the card's declared 2-line envelope
    expect(a14Need("HEADER_MIN_FONT_PCT")).toBe(90) // the ONE allowed scale step, per card
  })
  test("buildGrid runs one fit pass per header: over 2 lines -> shrink ONCE to the min font; STILL over -> dataset flag (surface, never silently re-abbreviate)", () => {
    const build = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function buildGrid"), INSPECTOR_UI_HTML.indexOf("function appendCell"))
    const js = INSPECTOR_UI_HTML.slice(INSPECTOR_UI_HTML.indexOf("function applyHeaderFit"))
    expect(js.length).toBeGreaterThan(0)
    const fn = js.slice(0, js.indexOf("function showRowBand")) // mechanism bounded at the named page-function boundary (checker self-validation)
    expect(fn).toMatch(/headerLineCount/) // consumes the exported core (single source, not a page fork)
    expect(fn).toMatch(/HEADER_MIN_FONT_PCT/)
    expect(fn).toMatch(/si-h2-tight/)
    // NEVER SILENT: an unfixed header is FLAGGED for the battery (F-code surface), not clipped back into hiding
    expect(fn).toMatch(/dataset\.(siHeaderOversize|si_header_oversize)/)
    expect(build).toMatch(/applyHeaderFit\(/)
    expect(INSPECTOR_UI_HTML).not.toMatch(/\.si-h2-tight[^}]*text-overflow/) // the fallback must not smuggle ellipsis back
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

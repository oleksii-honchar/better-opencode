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

import { GRID_COL_MIN_PX, gridTrackTemplate } from "./ui"

describe("ad2 pure cores — responsive grid tracks", () => {
  test("GRID_COL_MIN_PX honors the fit math at desktop: 12 default columns must fit ~1910 vw", () => {
    // stage content at 1910 vw ≈ 1600px (vw − sidebar 280 − resizer 6 − padding 24);
    // 12 tracks + 11 gaps(10) MUST fit at min width — otherwise no desktop width
    // shows the rightmost column fully (AC-1). Readability floor >= 110.
    expect(GRID_COL_MIN_PX).toBeGreaterThanOrEqual(110)
    expect(12 * GRID_COL_MIN_PX + 11 * 10).toBeLessThanOrEqual(1600)
  })

  test("gridTrackTemplate: one minmax(min,1fr) track per configured column — stretches to fill, floors at min", () => {
    expect(gridTrackTemplate(3)).toBe("minmax(120px, 1fr) minmax(120px, 1fr) minmax(120px, 1fr)")
    expect(gridTrackTemplate(0)).toBe("")
    // track COUNT == column count (split(" ") would count the ", " inside each
    // minmax() too — count the track constructors instead)
    expect((gridTrackTemplate(12).match(/minmax\(/g) ?? []).length).toBe(12)
    expect(gridTrackTemplate(4)).toContain(`minmax(${GRID_COL_MIN_PX}px, 1fr)`)
  })
})

describe("ad2 wiring pins on the served page", () => {
  test("buildGrid feeds config COUNT into the flex template — fixed px track widths are gone", () => {
    expect(INSPECTOR_UI_HTML).toContain("function gridTrackTemplate(")
    expect(INSPECTOR_UI_HTML).toMatch(/grid\.style\.gridTemplateColumns = gridTrackTemplate\(columns\(\)\.length\)/)
    expect(INSPECTOR_UI_HTML).not.toMatch(/gridTemplateColumns = columns\(\)\.map\(/) // negative guard: no fixed-track builder
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
    "si-header", "si-theme-toggle", "si-sidebar", "si-filter", "si-session-list",
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
    expect(INSPECTOR_UI_HTML).toMatch(/"data-testid": siCellTestId\(env\.category, cellSeq\+\+\)/)
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

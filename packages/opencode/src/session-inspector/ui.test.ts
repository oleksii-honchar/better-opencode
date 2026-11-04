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

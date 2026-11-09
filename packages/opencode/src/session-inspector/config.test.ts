import { describe, expect, test } from "bun:test"
import { loadInspectorConfig } from "./config"
import { memoryIO, tempDirs, GOLDEN_CATEGORY_IDS } from "./session-inspector.test-utils"

// Task 2 §5.1-3/§6.5/DEC-I contracts:
// - missing config file → built-in defaults + EXPLICIT warning banner marker (first-run friendly)
// - present-but-invalid (bad JSON / schema) → HARD FAIL, actionable error, never a partial config
// - user override file (valid) → merged effective config, no warning
// The section-replacement merge semantics (a present section replaces its default wholesale;
// an absent section keeps defaults) is the documented design choice for this task.

describe("loadInspectorConfig — defaults (no config file)", () => {
  test("absent file → ok with defaults plus explicit config-warning marker", () => {
    const dirs = tempDirs()
    const baseDirs = { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir }
    let result
    try {
      result = loadInspectorConfig({ configPath: dirs.configPath, io: memoryIO({}), baseDirs })
    } finally {
      dirs.cleanup()
    }
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`)

    expect(result.warning).toBeDefined()
    expect(result.warning?.code).toBe("CONFIG_FILE_MISSING")
    expect(result.warning?.message).toContain(dirs.configPath)

    const config = result.config
    expect(config.version).toBe(1)
    expect(config.categories.map((c) => c.id)).toEqual([...GOLDEN_CATEGORY_IDS])
    const byId = new Map(config.categories.map((c) => [c.id, c]))
    expect(byId.get("transitions")?.sources.historyEvents).toContain("persona.transition")
    expect(byId.get("transitions")?.sources.historyEvents).toContain("TRN")
    // v14 (Design v1 traceability, design 261107): the new names ship in the default
    // vocabulary — same 12 lanes, same order (GOLDEN set unchanged), names only added.
    expect(byId.get("transitions")?.sources.historyEvents).toContain("persona-boot")
    expect(byId.get("coach-judge")?.sources.historyEvents).toEqual(["plugin.judge", "judge-assess", "judge-summary"])
    expect(byId.get("coach-activity")?.sources.historyEvents).toEqual(["agent.coach", "gate-blocked", "nudge-delivered"])
    expect(byId.get("pipeline")?.sources.historyEvents).toEqual(["started", "handoff", "completed", "error"])
    expect(byId.get("other")?.catchAll).toBe(true)
    expect(config.paths.dbMode).toBe("engine-derived")
    expect(config.paths.agentsRoot).toBe(dirs.agentsDir)
    expect(config.paths.logsDir).toBe(dirs.logsDir)
    expect(config.limits.toolsLogEnrichment).toBe(true)
    expect(config.limits.payloadCapBytes).toBeGreaterThan(0)
    expect(config.cell.width).toBeGreaterThan(0)
    expect(config.cell.height).toBeGreaterThan(0)
  })

  test("category order is the §5.6 order (top→left), all enabled", () => {
    const baseDirs = { configDir: "/t/config", agentsDir: "/t/agents", logsDir: "/t/logs" }
    const result = loadInspectorConfig({ configPath: "/t/config/session-inspector.json", io: memoryIO({}), baseDirs })
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`)
    expect(result.config.categories.map((c) => c.order)).toEqual(result.config.categories.map((_, i) => i + 1))
    expect(result.config.categories.every((c) => c.enabled)).toBe(true)
  })
})

describe("loadInspectorConfig — valid user override", () => {
  test("cell section override replaces that section only; other sections stay defaults", () => {
    const configPath = "/t/config/session-inspector.json"
    const baseDirs = { configDir: "/t/config", agentsDir: "/t/agents", logsDir: "/t/logs" }
    const defaults = loadInspectorConfig({ configPath, io: memoryIO({}), baseDirs })
    if (!defaults.ok) throw new Error("defaults load failed")
    const result = loadInspectorConfig({
      configPath,
      io: memoryIO({ [configPath]: JSON.stringify({ cell: { width: 321, height: 77 } }) }),
      baseDirs,
    })
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`)

    expect(result.warning).toBeUndefined()
    expect(result.config.cell).toEqual({ width: 321, height: 77 })
    expect(result.config.categories).toEqual(defaults.config.categories)
    expect(result.config.paths).toEqual(defaults.config.paths)
    expect(result.config.limits).toEqual(defaults.config.limits)
  })

  test("explicit db path override in the file lands verbatim in effective config", () => {
    const configPath = "/t/config/session-inspector.json"
    const baseDirs = { configDir: "/t/config", agentsDir: "/t/agents", logsDir: "/t/logs" }
    const explicit = "/t/dbs/opencode-patched-dev2.db"
    const result = loadInspectorConfig({
      configPath,
      io: memoryIO({ [configPath]: JSON.stringify({ paths: { dbMode: "engine-derived", agentsRoot: "/t/agents", logsDir: "/t/logs" } }) }),
      baseDirs,
    })
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`)
    expect(result.config.paths.dbMode).toBe("engine-derived")

    const overridden = loadInspectorConfig({
      configPath,
      io: memoryIO({ [configPath]: JSON.stringify({ paths: { dbMode: explicit, agentsRoot: "/t/agents", logsDir: "/t/logs" } }) }),
      baseDirs,
    })
    if (!overridden.ok) throw new Error(`expected ok, got ${overridden.code}`)
    expect(overridden.config.paths.dbMode).toBe(explicit)
  })
})

describe("loadInspectorConfig — hard fail on present-but-invalid", () => {
  const baseDirs = { configDir: "/t/config", agentsDir: "/t/agents", logsDir: "/t/logs" }
  const configPath = "/t/config/session-inspector.json"
  const asFail = (result: ReturnType<typeof loadInspectorConfig>) => {
    if (result.ok) throw new Error("expected hard fail (ok:false), got ok:true — silent partial config")
    return result
  }

  test("malformed JSON → CONFIG_INVALID_JSON with actionable, path-mentioning message", () => {
    const failed = asFail(loadInspectorConfig({ configPath, io: memoryIO({ [configPath]: "{ not valid json" }), baseDirs }))
    expect(failed.code).toBe("CONFIG_INVALID_JSON")
    expect(failed.message).toContain(configPath)
  })

  test("wrong config version → CONFIG_INVALID_SCHEMA naming the field", () => {
    const failed = asFail(
      loadInspectorConfig({ configPath, io: memoryIO({ [configPath]: JSON.stringify({ version: 2 }) }), baseDirs }),
    )
    expect(failed.code).toBe("CONFIG_INVALID_SCHEMA")
    expect(failed.message).toContain("version")
  })

  test("unknown top-level key is rejected and named (strict root)", () => {
    const failed = asFail(
      loadInspectorConfig({
        configPath,
        io: memoryIO({ [configPath]: JSON.stringify({ cell2: { width: 1, height: 1 } }) }),
        baseDirs,
      }),
    )
    expect(failed.code).toBe("CONFIG_INVALID_SCHEMA")
    expect(failed.message).toContain("cell2")
  })

  test("duplicate category ids rejected naming categories", () => {
    const cat = (id: string, order: number) => ({
      id,
      title: id,
      order,
      sources: { historyEvents: ["some.event"] },
      enabled: true,
    })
    const failed = asFail(
      loadInspectorConfig({
        configPath,
        io: memoryIO({ [configPath]: JSON.stringify({ categories: [cat("a", 1), cat("a", 2)] }) }),
        baseDirs,
      }),
    )
    expect(failed.code).toBe("CONFIG_INVALID_SCHEMA")
    expect(failed.message).toContain("categories")
    expect(failed.message.toLowerCase()).toContain("duplicate")
  })

  test("unreadable config file → CONFIG_UNREADABLE, never a thrown error, no partial success", () => {
    const failed = asFail(loadInspectorConfig({ configPath, io: memoryIO({}, new Set([configPath])), baseDirs }))
    expect(failed.code).toBe("CONFIG_UNREADABLE")
    expect(failed.message).toContain(configPath)
  })
})

// ---------------------------------------------------------------------------
// AD28 — the SCOPED config surface the owner asked for: ui.grid.{columnWidthPx,
// cellHeightPx,labelFontPx}. Developer pre-rulings (binding): version STAYS 1;
// additive OPTIONAL strict section; defaults EQUAL to the shipped code constants —
// imported here from the code, NEVER hardcoded numbers (the no-behavior-change
// argument starts at the defaults). Section-replacement merge discipline.
import { GRID_TRACK_PX, CELL_BLOCK_H_PX, CELL_LABEL_FONT_PX } from "./ui"
describe("ad28 ui.grid — optional strict geometry section", () => {
  const baseDirs = { configDir: "/t/config", agentsDir: "/t/agents", logsDir: "/t/logs" }
  const configPath = "/t/config/session-inspector.json"
  const load = (content?: Record<string, unknown>) =>
    loadInspectorConfig({ configPath, io: memoryIO(content ? { [configPath]: JSON.stringify(content) } : {}), baseDirs })
  const okCfg = (r: ReturnType<typeof loadInspectorConfig>) => {
    if (!r.ok) throw new Error("expected ok, got " + r.code)
    return r.config
  }
  test("defaults: untouched file → ui.grid present, byte-equal to the SHIPPED CODE constants; version stays 1", () => {
    const cfg = okCfg(load())
    expect(cfg.version).toBe(1)
    expect(cfg.ui.grid.columnWidthPx).toBe(GRID_TRACK_PX) // read from the code — the values ARE the shipped pixels
    expect(cfg.ui.grid.cellHeightPx).toBe(CELL_BLOCK_H_PX)
    expect(cfg.ui.grid.labelFontPx).toBe(CELL_LABEL_FONT_PX)
    // RE-ANCHORED AD31 (named, stated reason): the ui section's key list literally gained
    // "colors" (additive optional, default {}) — carry the REAL post-change world; grid's
    // byte-equality pins and version-stays-1 intent unchanged.
    expect(Object.keys(cfg.ui).sort()).toEqual(["colors", "grid"])
    expect(Object.keys(cfg.ui.grid)).toEqual(["columnWidthPx", "cellHeightPx", "labelFontPx"])
  })
  test("a valid ui section is accepted and section-replaces the defaults; other sections stay default", () => {
    const cfg = okCfg(load({ ui: { grid: { columnWidthPx: 80, cellHeightPx: 20, labelFontPx: 12 } } }))
    expect(cfg.ui.grid).toEqual({ columnWidthPx: 80, cellHeightPx: 20, labelFontPx: 12 })
    expect(cfg.categories.length).toBe(GOLDEN_CATEGORY_IDS.length)
    expect(cfg.limits.payloadCapBytes).toBe(okCfg(load()).limits.payloadCapBytes)
    expect(cfg.version).toBe(1)
  })
  test("present-but-incomplete ui section is a hard fail naming the missing member (complete-when-present)", () => {
    const r = load({ ui: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("CONFIG_INVALID_SCHEMA")
    expect(r.message).toContain("grid")
  })
  test("out-of-range values hard-fail naming the exact field and range vocabulary", () => {
    for (const [key, bad, min, max] of [
      ["columnWidthPx", 20, 24, 200],
      ["columnWidthPx", 201, 24, 200],
      ["cellHeightPx", 9, 10, 40],
      ["labelFontPx", 25, 6, 24],
      ["labelFontPx", 9.5, 6, 24],
    ] as const) {
      const r = load({ ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9, [key]: bad } as any } })
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.code).toBe("CONFIG_INVALID_SCHEMA")
      expect(r.message).toContain(`ui.grid.${key}`) // config errors print the dotted issue path
      void min; void max
    }
  })
  test("unknown key inside grid is rejected and named (strict section)", () => {
    const r = load({ ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9, mode: "cozy" } as any } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("CONFIG_INVALID_SCHEMA")
    expect(r.message).toContain("mode")
  })
  test("the OWNER's live-file posture survives: an unchanged v1 file without ui stays valid (zero migration)", () => {
    // exactly what the owner already has: version + categories etc., NO ui section.
    const minimalV1 = { paths: { dbMode: "engine-derived", agentsRoot: "/t/a", logsDir: "/t/l" } }
    const cfg = okCfg(load(minimalV1))
    expect(cfg.ui.grid.columnWidthPx).toBe(GRID_TRACK_PX) // defaults fill the absent section
  })
})

// AD31 — ui.colors: optional per-category { bg?: HEX6, text?: HEX6|"text=auto" } —
// strict grammar, id membership over the MERGED categories (naming the offender AND the
// valid ids), section-replacement, version stays 1, default = {} (all-auto derivation).
describe("ad31 ui.colors grammar (config.schema via loadInspectorConfig)", () => {
  test("valid: bg + explicit text + 'auto' accepted; ids must exist; partial per-lane ok", () => {
    const dirs = tempDirs()
      const configPath = dirs.configDir + "/session-inspector.json"
      const baseDirs = { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir }
      const r = loadInspectorConfig({ configPath, io: memoryIO({ [configPath]: JSON.stringify({
      ui: {
        grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 }, // grammar: grid required when ui present (untouched)
        colors: {
          "tool-calls": { bg: "#1e1b4b" },
          "reasoning": { text: "auto" },
          "lifecycle": { bg: "#bfdbfe", text: "#111827" },
        },
      },
    }) }), baseDirs })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.ui?.colors).toEqual({ "tool-calls": { bg: "#1e1b4b" }, "reasoning": { text: "auto" }, "lifecycle": { bg: "#bfdbfe", text: "#111827" } })
    // partial per-lane objects preserved as given (not expanded)
  })
  test("bad hex rejected by the CONFIG_INVALID_SCHEMA path naming the field", () => {
    const dirs = tempDirs()
      const configPath = dirs.configDir + "/session-inspector.json"
      const baseDirs = { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir }
      const r = loadInspectorConfig({ configPath, io: memoryIO({ [configPath]: JSON.stringify({ ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 }, colors: { "reasoning": { bg: "#1e1b4" } } } }) }), baseDirs })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe("CONFIG_INVALID_SCHEMA"); expect(r.message).toMatch(/bg/) }
  })
  test("unknown category id HARD-FAILS naming the id AND listing the valid ids (merged world)", () => {
    const dirs = tempDirs()
      const configPath = dirs.configDir + "/session-inspector.json"
      const baseDirs = { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir }
      const r = loadInspectorConfig({ configPath, io: memoryIO({ [configPath]: JSON.stringify({ ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 }, colors: { "reasonin": { bg: "#1e1b4b" } } } }) }), baseDirs })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe("CONFIG_INVALID_SCHEMA"); expect(r.message).toContain("reasonin"); expect(r.message).toContain("reasoning") }
  })
  test("absent colors → default {} (all-auto; behavior = derivation on built-ins)", () => {
    const dirs = tempDirs()
    const configPath = dirs.configDir + "/session-inspector.json"
    const baseDirs = { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir }
    const r = loadInspectorConfig({ configPath, io: memoryIO({ [configPath]: JSON.stringify({ version: 1 }) }), baseDirs })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.ui?.colors ?? {}).toEqual({})
  })
  test("version STAYS 1 with ui.colors present; section-replacement: present colors replaces wholesale-like other sections", () => {
    const withColors = JSON.stringify({ version: 1, ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 }, colors: { "reasoning": { bg: "#123456" } } } })
      const dirs = tempDirs()
      const configPath = dirs.configDir + "/session-inspector.json"
      const baseDirs = { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir }
      const r = loadInspectorConfig({ configPath, io: memoryIO({ [configPath]: withColors }), baseDirs })
    expect(r.ok && r.config.version).toBe(1)
    if (r.ok) expect(r.config.ui?.colors).toEqual({ "reasoning": { bg: "#123456" } }) // served back verbatim, no injection of defaults per-lane
  })
})

// AD32 R3 — fresh-read audit (CHARACTERIZATION lanes: they pin CURRENT truth as the card's
// load-bearing proof; no new semantics). Through the injected IO seam only: every call =
// exactly one read of the config path, nothing cached across calls, a second call sees the
// NEW file content (same process — this is what makes HTTP per-request reads fresh).
describe("ad32 fresh-read through injected IO seam (characterization, no-cache)", () => {
  test("one read per call, no caching, second call observes changed bytes", () => {
    const dirs = tempDirs()
    const configPath = dirs.configDir + "/session-inspector.json"
    const baseDirs = { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir }
    const files: Record<string, string> = {
      [configPath]: JSON.stringify({ ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 } } }),
    }
    let reads = 0
    const io = {
      read: (p: string) => {
        if (p === configPath) reads++
        if (p in files) return { kind: "ok" as const, text: files[p] }
        return { kind: "missing" as const }
      },
    }
    const r1 = loadInspectorConfig({ configPath, io, baseDirs })
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.config.ui.grid.columnWidthPx).toBe(64)
    expect(reads).toBe(1) // exactly one config-file read per call — no double-read, no cache layer to double-read
    files[configPath] = JSON.stringify({ ui: { grid: { columnWidthPx: 40, cellHeightPx: 12, labelFontPx: 8 } } })
    files[configPath.replace("session-inspector.json", "other.json")] = "{}"
    const r2 = loadInspectorConfig({ configPath, io, baseDirs })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.config.ui.grid.columnWidthPx).toBe(40) // NEW content seen by the second call — zero process-level cache
    expect(reads).toBe(2)
    void baseDirs
  })
  test("invalid bytes are a HARD failure with zero partial state (DEC-I unchanged — characterization before shell change)", () => {
    const dirs = tempDirs()
    const configPath = dirs.configDir + "/session-inspector.json"
    const baseDirs = { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir }
    const io = memoryIO({ [configPath]: JSON.stringify({ ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 }, colors: { "reasoning": { bg: "#nothex" } } } }) })
    const r = loadInspectorConfig({ configPath, io, baseDirs })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe("CONFIG_INVALID_SCHEMA"); expect(r.message).toMatch(/bg/) }
  })
})

// AD34 — theme-aware per-lane color grammar: { bg?, bgDark?, text?, textDark? } additive
// optional keys on the SAME strict per-lane object (version stays 1, defaults stay {}, id
// membership unchanged). Subsets are independent legal worlds: bgDark alone = dark-only
// override; text alone leaves dark on auto. Unknown keys keep the named hard-fail, and the
// failure names the LEGAL key set INCLUDING the new theme keys.
describe("ad34 theme-aware color grammar (bgDark/textDark additive, config.schema via loadInspectorConfig)", () => {
  const dirsOf = () => {
    const dirs = tempDirs()
    const configPath = dirs.configDir + "/session-inspector.json"
    const baseDirs = { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir }
    return { dirs, configPath, baseDirs }
  }
  const load = (payload: unknown) => {
    const { dirs, configPath, baseDirs } = dirsOf()
    return loadInspectorConfig({ configPath, io: memoryIO({ [configPath]: JSON.stringify(payload) }), baseDirs })
  }
  test("valid subsets: full {bg,bgDark,text,textDark}; bgDark-only (dark override, light stays built-in); text+textDark; 'auto' on either text key — served back verbatim", () => {
    const colors = {
      "reasoning": { bg: "#8b5cf6", bgDark: "#a78bfa", text: "auto", textDark: "auto" },
      "tool-calls": { bgDark: "#1e1b4b" },
      "lifecycle": { text: "#111827", textDark: "auto" },
    }
    const r = load({ ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 }, colors } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.ui?.colors).toEqual(colors) // no expansion, no injection — verbatim (grammar unchanged in kind)
  })
  test("invalid values under the new keys are HARD-rejected naming the field (bgDark hex, textDark union)", () => {
    const bad = load({ ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 }, colors: { "reasoning": { bgDark: "#1e1b4" } } } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) { expect(bad.code).toBe("CONFIG_INVALID_SCHEMA"); expect(bad.message).toMatch(/bgDark/) }
    const badText = load({ ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 }, colors: { "reasoning": { textDark: "automatic" } } } })
    expect(badText.ok).toBe(false)
    if (!badText.ok) { expect(badText.code).toBe("CONFIG_INVALID_SCHEMA"); expect(badText.message).toMatch(/textDark/) }
  })
  test("unknown key still names the offender AND lists the legal key set INCLUDING bgDark/textDark (grammar surface is discoverable from the error)", () => {
    const r = load({ ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 }, colors: { "reasoning": { bgcolor: "#1e1b4b" } } } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("CONFIG_INVALID_SCHEMA")
      expect(r.message).toMatch(/bgcolor/)
      expect(r.message).toMatch(/bgDark/); expect(r.message).toMatch(/textDark/)
    }
  })
  test("version STAYS 1 with theme-aware keys present; defaults unchanged (absent section = {})", () => {
    const r = load({ version: 1, ui: { grid: { columnWidthPx: 64, cellHeightPx: 14, labelFontPx: 9 }, colors: { "other": { bgDark: "#0a0a0a", textDark: "auto" } } } })
    expect(r.ok && r.config.version).toBe(1)
    const absent = load({ version: 1 })
    expect(absent.ok).toBe(true)
    if (absent.ok) expect(absent.config.ui?.colors ?? {}).toEqual({}) // R1 regression: no-omission world byte-identical
  })
})

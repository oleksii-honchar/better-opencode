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

import { describe, expect, test } from "bun:test"
import { defaultConfig, defaultEvidenceThresholds, mergeConfig, validateUnstuckConfig, type UnstuckConfig } from "./config"

describe("UnstuckConfig — new XML fields", () => {
  test("defaultConfig has xmlRepetitionModelId as undefined", () => {
    expect(defaultConfig.xmlRepetitionModelId).toBeUndefined()
  })

  test("defaultConfig has xmlPartialTagThreshold = 2", () => {
    expect(defaultConfig.xmlPartialTagThreshold).toBe(2)
  })

  test("defaultConfig has xmlPartialTagDetection = true", () => {
    expect(defaultConfig.xmlPartialTagDetection).toBe(true)
  })

  test("defaultConfig has xmlTokenEstimationMultiplier = 1.5", () => {
    expect(defaultConfig.xmlTokenEstimationMultiplier).toBe(1.5)
  })

  test("mergeConfig overrides xmlRepetitionModelId", () => {
    const merged = mergeConfig({ xmlRepetitionModelId: "qwen3.6-40b" })
    expect(merged.xmlRepetitionModelId).toBe("qwen3.6-40b")
  })

  test("mergeConfig overrides xmlPartialTagThreshold", () => {
    const merged = mergeConfig({ xmlPartialTagThreshold: 3 })
    expect(merged.xmlPartialTagThreshold).toBe(3)
  })

  test("mergeConfig overrides xmlPartialTagDetection", () => {
    const merged = mergeConfig({ xmlPartialTagDetection: false })
    expect(merged.xmlPartialTagDetection).toBe(false)
  })

  test("mergeConfig overrides xmlTokenEstimationMultiplier", () => {
    const merged = mergeConfig({ xmlTokenEstimationMultiplier: 2.0 })
    expect(merged.xmlTokenEstimationMultiplier).toBe(2.0)
  })

  test("mergeConfig preserves defaults for unspecified new fields", () => {
    const merged = mergeConfig({ enabled: false })
    expect(merged.xmlRepetitionModelId).toBeUndefined()
    expect(merged.xmlPartialTagThreshold).toBe(2)
    expect(merged.xmlPartialTagDetection).toBe(true)
    expect(merged.xmlTokenEstimationMultiplier).toBe(1.5)
  })

  test("mergeConfig overrides all new fields at once", () => {
    const merged = mergeConfig({
      xmlRepetitionModelId: "qwen3.6-40b",
      xmlPartialTagThreshold: 1,
      xmlPartialTagDetection: false,
      xmlTokenEstimationMultiplier: 2.0,
    })
    expect(merged.xmlRepetitionModelId).toBe("qwen3.6-40b")
    expect(merged.xmlPartialTagThreshold).toBe(1)
    expect(merged.xmlPartialTagDetection).toBe(false)
    expect(merged.xmlTokenEstimationMultiplier).toBe(2.0)
  })
})

describe("UnstuckConfig — Task 14: Sensible Defaults", () => {
  test("default config is a valid UnstuckConfig (no runtime errors)", () => {
    const config = defaultConfig
    expect(config.enabled).toBeDefined()
    expect(config.loopThreshold).toBeDefined()
    expect(config.xmlRepetitionModelId).toBeUndefined()
    expect(config.xmlPartialTagThreshold).toBe(2)
    expect(config.xmlPartialTagDetection).toBe(true)
    expect(config.xmlTokenEstimationMultiplier).toBe(1.5)
  })

  test("backward compatibility — mergeConfig with empty partial uses all defaults", () => {
    const merged = mergeConfig({})
    expect(merged).toEqual(defaultConfig)
  })

  test("backward compatibility — old config without new fields gets defaults", () => {
    const oldStyleConfig: Partial<UnstuckConfig> = {
      enabled: false,
      loopThreshold: 5,
      strategy: "abort",
    }
    const merged = mergeConfig(oldStyleConfig)
    expect(merged.enabled).toBe(false)
    expect(merged.loopThreshold).toBe(5)
    expect(merged.strategy).toBe("abort")
    // New fields should get defaults
    expect(merged.xmlRepetitionModelId).toBeUndefined()
    expect(merged.xmlPartialTagThreshold).toBe(2)
    expect(merged.xmlPartialTagDetection).toBe(true)
    expect(merged.xmlTokenEstimationMultiplier).toBe(1.5)
  })

  test("defaults are appropriate for Qwen — sensitive partial tag detection", () => {
    // Partial tag threshold of 2 is very sensitive — catches Qwen's malformed XML early
    expect(defaultConfig.xmlPartialTagThreshold).toBeLessThanOrEqual(3)
    // Partial tag detection is enabled by default — Qwen needs it
    expect(defaultConfig.xmlPartialTagDetection).toBe(true)
  })

  test("defaults are appropriate for Qwen — conservative XML token estimation", () => {
    // Multiplier of 1.5 is 50% more conservative — triggers earlier interruption
    expect(defaultConfig.xmlTokenEstimationMultiplier).toBeGreaterThan(1.0)
    expect(defaultConfig.xmlTokenEstimationMultiplier).toBeLessThanOrEqual(2.0)
  })

  test("defaults are appropriate for Qwen — no model-specific override by default", () => {
    // xmlRepetitionModelId undefined means no model-specific overrides
    // This is correct: the wrapper layer should set modelId based on provider context
    expect(defaultConfig.xmlRepetitionModelId).toBeUndefined()
  })

  test("mergeConfig preserves evidenceThresholds deep merge with new fields", () => {
    const merged = mergeConfig({
      enabled: true,
      xmlPartialTagThreshold: 3,
      evidenceThresholds: { stepLoop: 5 },
    })
    expect(merged.xmlPartialTagThreshold).toBe(3)
    expect(merged.evidenceThresholds.stepLoop).toBe(5)
    expect(merged.evidenceThresholds.xmlRepetition).toBe(1) // default preserved
  })
})

describe("UnstuckConfig — Task 15: Validation", () => {
  test("validateUnstuckConfig corrects xmlPartialTagThreshold < 1 to default (2)", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlPartialTagThreshold: 0 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlPartialTagThreshold).toBe(2)
  })

  test("validateUnstuckConfig corrects xmlPartialTagThreshold negative to default (2)", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlPartialTagThreshold: -5 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlPartialTagThreshold).toBe(2)
  })

  test("validateUnstuckConfig preserves valid xmlPartialTagThreshold", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlPartialTagThreshold: 5 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlPartialTagThreshold).toBe(5)
  })

  test("validateUnstuckConfig preserves xmlPartialTagThreshold exactly 1", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlPartialTagThreshold: 1 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlPartialTagThreshold).toBe(1)
  })

  test("validateUnstuckConfig corrects xmlTokenEstimationMultiplier < 1.0 to default (1.5)", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlTokenEstimationMultiplier: 0.5 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlTokenEstimationMultiplier).toBe(1.5)
  })

  test("validateUnstuckConfig corrects xmlTokenEstimationMultiplier zero to default (1.5)", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlTokenEstimationMultiplier: 0 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlTokenEstimationMultiplier).toBe(1.5)
  })

  test("validateUnstuckConfig corrects xmlTokenEstimationMultiplier negative to default (1.5)", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlTokenEstimationMultiplier: -1.0 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlTokenEstimationMultiplier).toBe(1.5)
  })

  test("validateUnstuckConfig preserves valid xmlTokenEstimationMultiplier", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlTokenEstimationMultiplier: 3.0 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlTokenEstimationMultiplier).toBe(3.0)
  })

  test("validateUnstuckConfig preserves xmlTokenEstimationMultiplier exactly 1.0", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlTokenEstimationMultiplier: 1.0 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlTokenEstimationMultiplier).toBe(1.0)
  })

  test("validateUnstuckConfig corrects xmlRepetitionThreshold < 1 to default (4)", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlRepetitionThreshold: 0 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlRepetitionThreshold).toBe(4)
  })

  test("validateUnstuckConfig corrects xmlRepetitionThreshold negative to default (4)", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlRepetitionThreshold: -3 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlRepetitionThreshold).toBe(4)
  })

  test("validateUnstuckConfig preserves valid xmlRepetitionThreshold", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlRepetitionThreshold: 10 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlRepetitionThreshold).toBe(10)
  })

  test("validateUnstuckConfig preserves xmlRepetitionThreshold exactly 1", () => {
    const config: UnstuckConfig = { ...defaultConfig, xmlRepetitionThreshold: 1 }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlRepetitionThreshold).toBe(1)
  })

  test("validateUnstuckConfig corrects multiple invalid fields at once", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      xmlPartialTagThreshold: 0,
      xmlTokenEstimationMultiplier: 0.1,
      xmlRepetitionThreshold: 0,
    }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlPartialTagThreshold).toBe(2)
    expect(validated.xmlTokenEstimationMultiplier).toBe(1.5)
    expect(validated.xmlRepetitionThreshold).toBe(4)
  })

  test("validateUnstuckConfig does not modify other config fields", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      xmlPartialTagThreshold: 0,
      enabled: false,
      strategy: "abort",
    }
    const validated = validateUnstuckConfig(config)
    expect(validated.xmlPartialTagThreshold).toBe(2)
    expect(validated.enabled).toBe(false)
    expect(validated.strategy).toBe("abort")
  })

  test("validateUnstuckConfig is idempotent — running twice produces same result", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      xmlPartialTagThreshold: 0,
      xmlTokenEstimationMultiplier: 0.5,
    }
    const once = validateUnstuckConfig(config)
    const twice = validateUnstuckConfig(once)
    expect(twice.xmlPartialTagThreshold).toBe(once.xmlPartialTagThreshold)
    expect(twice.xmlTokenEstimationMultiplier).toBe(once.xmlTokenEstimationMultiplier)
  })

  test("mergeConfig with invalid values — validation corrects them", () => {
    const merged = mergeConfig({
      xmlPartialTagThreshold: 0,
      xmlTokenEstimationMultiplier: 0.5,
      xmlRepetitionThreshold: 0,
    })
    expect(merged.xmlPartialTagThreshold).toBe(2)
    expect(merged.xmlTokenEstimationMultiplier).toBe(1.5)
    expect(merged.xmlRepetitionThreshold).toBe(4)
  })
})

describe("UnstuckConfig — Task 2: cross-stream doom-loop config fields", () => {
  test("UnstuckConfig exposes enableCrossStreamDoomLoopDetection and crossStreamDoomLoopThreshold", () => {
    const config: UnstuckConfig = defaultConfig
    expect("enableCrossStreamDoomLoopDetection" in config).toBe(true)
    expect("crossStreamDoomLoopThreshold" in config).toBe(true)
  })

  test("defaultConfig.enableCrossStreamDoomLoopDetection === true", () => {
    expect(defaultConfig.enableCrossStreamDoomLoopDetection).toBe(true)
  })

  test("defaultConfig.crossStreamDoomLoopThreshold === 3", () => {
    expect(defaultConfig.crossStreamDoomLoopThreshold).toBe(3)
  })

  test("mergeConfig({}) retains cross-stream doom-loop defaults", () => {
    const merged = mergeConfig({})
    expect(merged.enableCrossStreamDoomLoopDetection).toBe(true)
    expect(merged.crossStreamDoomLoopThreshold).toBe(3)
  })

  test("mergeConfig({ crossStreamDoomLoopThreshold: 5 }) overrides threshold", () => {
    const merged = mergeConfig({ crossStreamDoomLoopThreshold: 5 })
    expect(merged.crossStreamDoomLoopThreshold).toBe(5)
    expect(merged.enableCrossStreamDoomLoopDetection).toBe(true)
  })

  test("mergeConfig({ enableCrossStreamDoomLoopDetection: false }) overrides the switch", () => {
    const merged = mergeConfig({ enableCrossStreamDoomLoopDetection: false })
    expect(merged.enableCrossStreamDoomLoopDetection).toBe(false)
    expect(merged.crossStreamDoomLoopThreshold).toBe(3)
  })

  test("mergeConfig with both cross-stream fields overrides both", () => {
    const merged = mergeConfig({
      enableCrossStreamDoomLoopDetection: false,
      crossStreamDoomLoopThreshold: 7,
    })
    expect(merged.enableCrossStreamDoomLoopDetection).toBe(false)
    expect(merged.crossStreamDoomLoopThreshold).toBe(7)
  })

  test("validateUnstuckConfig preserves cross-stream doom-loop fields", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      enableCrossStreamDoomLoopDetection: false,
      crossStreamDoomLoopThreshold: 7,
    }
    const validated = validateUnstuckConfig(config)
    expect(validated.enableCrossStreamDoomLoopDetection).toBe(false)
    expect(validated.crossStreamDoomLoopThreshold).toBe(7)
  })
})

describe("UnstuckConfig — Task 2: pruneCount removal and strategy rename", () => {
  test("UnstuckConfig does not have pruneCount field", () => {
    const config: UnstuckConfig = defaultConfig
    expect("pruneCount" in config).toBe(false)
  })

  test("defaultConfig has no pruneCount property", () => {
    expect((defaultConfig as any).pruneCount).toBeUndefined()
  })

  test("default strategy is nudge", () => {
    expect(defaultConfig.strategy).toBe("nudge")
  })

  test("strategy union accepts nudge as a value", () => {
    const config: UnstuckConfig = { ...defaultConfig, strategy: "nudge" }
    expect(config.strategy).toBe("nudge")
  })

  test("strategy union accepts nudge-and-prune as a legacy alias", () => {
    const config: UnstuckConfig = { ...defaultConfig, strategy: "nudge-and-prune" }
    expect(config.strategy).toBe("nudge-and-prune")
  })

  test("mergeConfig with legacy nudge-and-prune strategy is accepted", () => {
    const merged = mergeConfig({ strategy: "nudge-and-prune" })
    expect(merged.strategy).toBe("nudge-and-prune")
  })

  test("mergeConfig with nudge strategy is accepted", () => {
    const merged = mergeConfig({ strategy: "nudge" })
    expect(merged.strategy).toBe("nudge")
  })

  test("nudge strategy parses successfully from input config", () => {
    const merged = mergeConfig({ strategy: "nudge", enabled: true })
    expect(merged.strategy).toBe("nudge")
    expect(merged.enabled).toBe(true)
  })

  test("pruneCount in input config is ignored and undefined in output", () => {
    const merged = mergeConfig({ pruneCount: 5 } as Partial<UnstuckConfig>)
    expect((merged as any).pruneCount).toBeUndefined()
  })

  test("mergeConfig with empty partial retains nudge default", () => {
    const merged = mergeConfig({})
    expect(merged.strategy).toBe("nudge")
  })

  test("mergeConfig ignores pruneCount in input — output has no pruneCount", () => {
    const merged = mergeConfig({ pruneCount: 5 } as unknown as Partial<UnstuckConfig>)
    expect((merged as unknown as Record<string, unknown>).pruneCount).toBeUndefined()
  })

  test("validateUnstuckConfig ignores pruneCount in input — output has no pruneCount", () => {
    const config = { ...defaultConfig, pruneCount: 5 } as unknown as UnstuckConfig
    const validated = validateUnstuckConfig(config)
    expect((validated as unknown as Record<string, unknown>).pruneCount).toBeUndefined()
  })
})

describe("UnstuckConfig — Task 2: doom_loop flags", () => {
  test("UnstuckConfig exposes enableDoomLoopDetection and doomLoopThreshold", () => {
    const config: UnstuckConfig = defaultConfig
    expect("enableDoomLoopDetection" in config).toBe(true)
    expect("doomLoopThreshold" in config).toBe(true)
  })

  test("defaultConfig.enableDoomLoopDetection === true", () => {
    expect(defaultConfig.enableDoomLoopDetection).toBe(true)
  })

  test("defaultConfig.doomLoopThreshold === 3", () => {
    expect(defaultConfig.doomLoopThreshold).toBe(3)
  })

  test("defaultEvidenceThresholds.doomLoop === 1", () => {
    expect(defaultEvidenceThresholds.doomLoop).toBe(1)
    expect(defaultConfig.evidenceThresholds.doomLoop).toBe(1)
  })

  test("mergeConfig({}) retains doom_loop defaults", () => {
    const merged = mergeConfig({})
    expect(merged.enableDoomLoopDetection).toBe(true)
    expect(merged.doomLoopThreshold).toBe(3)
    expect(merged.evidenceThresholds.doomLoop).toBe(1)
  })

  test("mergeConfig({ doomLoopThreshold: 5 }) overrides threshold", () => {
    const merged = mergeConfig({ doomLoopThreshold: 5 })
    expect(merged.doomLoopThreshold).toBe(5)
    expect(merged.enableDoomLoopDetection).toBe(true)
  })

  test("mergeConfig({ enableDoomLoopDetection: false }) overrides the switch", () => {
    const merged = mergeConfig({ enableDoomLoopDetection: false })
    expect(merged.enableDoomLoopDetection).toBe(false)
    expect(merged.doomLoopThreshold).toBe(3)
  })

  test("mergeConfig({ evidenceThresholds: { stepLoop: 3 } }) keeps doomLoop: 1", () => {
    const merged = mergeConfig({ evidenceThresholds: { stepLoop: 3 } })
    expect(merged.evidenceThresholds.stepLoop).toBe(3)
    expect(merged.evidenceThresholds.doomLoop).toBe(1)
  })

  test("mergeConfig({ evidenceThresholds: { doomLoop: 4 } }) overrides doomLoop", () => {
    const merged = mergeConfig({ evidenceThresholds: { doomLoop: 4 } })
    expect(merged.evidenceThresholds.doomLoop).toBe(4)
    expect(merged.evidenceThresholds.stepLoop).toBe(2)
  })

  test("validateUnstuckConfig preserves doom_loop fields", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      enableDoomLoopDetection: false,
      doomLoopThreshold: 7,
      evidenceThresholds: { ...defaultConfig.evidenceThresholds, doomLoop: 3 },
    }
    const validated = validateUnstuckConfig(config)
    expect(validated.enableDoomLoopDetection).toBe(false)
    expect(validated.doomLoopThreshold).toBe(7)
    expect(validated.evidenceThresholds.doomLoop).toBe(3)
  })
})

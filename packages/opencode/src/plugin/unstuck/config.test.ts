import { describe, expect, test } from "bun:test"
import { defaultConfig, mergeConfig, validateUnstuckConfig, type UnstuckConfig } from "./config"

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

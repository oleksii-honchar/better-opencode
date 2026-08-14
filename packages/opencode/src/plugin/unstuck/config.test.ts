import { describe, expect, test } from "bun:test"
import { defaultConfig, defaultEvidenceThresholds, mergeConfig, validateUnstuckConfig, type UnstuckConfig } from "./config"

describe("UnstuckConfig — Task 1: Config defaults and new fields", () => {
  test("defaultConfig.maxNudges is 2", () => {
    expect(defaultConfig.maxNudges).toBe(2)
  })

  test("defaultEvidenceThresholds.sentenceLoop is 3", () => {
    expect(defaultEvidenceThresholds.sentenceLoop).toBe(3)
  })

  test("defaultEvidenceThresholds.selfDiagnosis is 3", () => {
    expect(defaultEvidenceThresholds.selfDiagnosis).toBe(3)
  })

  test("defaultConfig.enableCrossStreamDoomLoopDetection is false", () => {
    expect(defaultConfig.enableCrossStreamDoomLoopDetection).toBe(false)
  })

  test("UnstuckConfig interface has sentenceLoopIncludeReasoning field", () => {
    const config: UnstuckConfig = defaultConfig
    expect("sentenceLoopIncludeReasoning" in config).toBe(true)
  })

  test("UnstuckConfig interface has doomLoopIgnorePatterns field", () => {
    const config: UnstuckConfig = defaultConfig
    expect("doomLoopIgnorePatterns" in config).toBe(true)
  })

  test("defaultConfig.sentenceLoopIncludeReasoning is false", () => {
    expect(defaultConfig.sentenceLoopIncludeReasoning).toBe(false)
  })

  test("defaultConfig.doomLoopIgnorePatterns contains expected patterns", () => {
    expect(defaultConfig.doomLoopIgnorePatterns).toEqual(["/\\.rules\\/", "\\.mdc"])
  })

  test("mergeConfig with empty partial retains new defaults", () => {
    const merged = mergeConfig({})
    expect(merged.maxNudges).toBe(2)
    expect(merged.evidenceThresholds.sentenceLoop).toBe(3)
    expect(merged.evidenceThresholds.selfDiagnosis).toBe(3)
    expect(merged.enableCrossStreamDoomLoopDetection).toBe(false)
    expect(merged.sentenceLoopIncludeReasoning).toBe(false)
    expect(merged.doomLoopIgnorePatterns).toEqual(["/\\.rules\\/", "\\.mdc"])
  })

  test("mergeConfig allows overriding new fields", () => {
    const merged = mergeConfig({
      maxNudges: 5,
      sentenceLoopIncludeReasoning: true,
      doomLoopIgnorePatterns: ["/ignore/"],
      enableCrossStreamDoomLoopDetection: true,
      evidenceThresholds: { sentenceLoop: 5, selfDiagnosis: 1 },
    })
    expect(merged.maxNudges).toBe(5)
    expect(merged.sentenceLoopIncludeReasoning).toBe(true)
    expect(merged.doomLoopIgnorePatterns).toEqual(["/ignore/"])
    expect(merged.enableCrossStreamDoomLoopDetection).toBe(true)
    expect(merged.evidenceThresholds.sentenceLoop).toBe(5)
    expect(merged.evidenceThresholds.selfDiagnosis).toBe(1)
  })
})

describe("UnstuckConfig — Task 14: Sensible Defaults", () => {
  test("default config is a valid UnstuckConfig (no runtime errors)", () => {
    const config = defaultConfig
    expect(config.enabled).toBeDefined()
    expect(config.loopThreshold).toBeDefined()
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
  })

  test("mergeConfig preserves evidenceThresholds deep merge", () => {
    const merged = mergeConfig({
      enabled: true,
      evidenceThresholds: { stepLoop: 5 },
    })
    expect(merged.evidenceThresholds.stepLoop).toBe(5)
    expect(merged.evidenceThresholds.doomLoop).toBe(1) // default preserved
  })
})

describe("UnstuckConfig — Task 15: Validation", () => {
  test("validateUnstuckConfig strips pruneCount if present", () => {
    const config = { ...defaultConfig, pruneCount: 5 } as unknown as UnstuckConfig
    const validated = validateUnstuckConfig(config)
    expect((validated as unknown as Record<string, unknown>).pruneCount).toBeUndefined()
  })

  test("validateUnstuckConfig does not modify other config fields", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      enabled: false,
      strategy: "abort",
    }
    const validated = validateUnstuckConfig(config)
    expect(validated.enabled).toBe(false)
    expect(validated.strategy).toBe("abort")
  })

  test("validateUnstuckConfig is idempotent — running twice produces same result", () => {
    const config: UnstuckConfig = defaultConfig
    const once = validateUnstuckConfig(config)
    const twice = validateUnstuckConfig(once)
    expect(twice).toEqual(once)
  })
})

describe("UnstuckConfig — Task 2: cross-stream doom-loop config fields", () => {
  test("UnstuckConfig exposes enableCrossStreamDoomLoopDetection and crossStreamDoomLoopThreshold", () => {
    const config: UnstuckConfig = defaultConfig
    expect("enableCrossStreamDoomLoopDetection" in config).toBe(true)
    expect("crossStreamDoomLoopThreshold" in config).toBe(true)
  })

  test("defaultConfig.enableCrossStreamDoomLoopDetection === false (opt-in, Task 1)", () => {
    expect(defaultConfig.enableCrossStreamDoomLoopDetection).toBe(false)
  })

  test("defaultConfig.crossStreamDoomLoopThreshold === 3", () => {
    expect(defaultConfig.crossStreamDoomLoopThreshold).toBe(3)
  })

  test("mergeConfig({}) retains cross-stream doom-loop defaults (opt-in false, Task 1)", () => {
    const merged = mergeConfig({})
    expect(merged.enableCrossStreamDoomLoopDetection).toBe(false)
    expect(merged.crossStreamDoomLoopThreshold).toBe(3)
  })

  test("mergeConfig({ crossStreamDoomLoopThreshold: 5 }) overrides threshold", () => {
    const merged = mergeConfig({ crossStreamDoomLoopThreshold: 5 })
    expect(merged.crossStreamDoomLoopThreshold).toBe(5)
    expect(merged.enableCrossStreamDoomLoopDetection).toBe(false)
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

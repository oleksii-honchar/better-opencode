import { describe, expect, test } from "bun:test"
import { defaultConfig, mergeConfig, type RulesInjectConfig } from "./config"

describe("RulesInjectConfig — defaults", () => {
  test("defaultConfig.enabled === true", () => {
    expect(defaultConfig.enabled).toBe(true)
  })

  test('defaultConfig.alwaysApplyFolder === "~/.rules/always-apply"', () => {
    expect(defaultConfig.alwaysApplyFolder).toBe("~/.rules/always-apply")
  })

  test("defaultConfig satisfies the RulesInjectConfig interface", () => {
    const config: RulesInjectConfig = defaultConfig
    expect(config.enabled).toBe(true)
    expect(config.alwaysApplyFolder).toBe("~/.rules/always-apply")
  })
})

describe("RulesInjectConfig — mergeConfig", () => {
  test("mergeConfig({}) returns the full defaults", () => {
    const merged = mergeConfig({})
    expect(merged).toEqual(defaultConfig)
    expect(merged.enabled).toBe(true)
    expect(merged.alwaysApplyFolder).toBe("~/.rules/always-apply")
  })

  test("mergeConfig({ enabled: false }) flips only enabled", () => {
    const merged = mergeConfig({ enabled: false })
    expect(merged.enabled).toBe(false)
    expect(merged.alwaysApplyFolder).toBe("~/.rules/always-apply")
  })

  test('mergeConfig({ alwaysApplyFolder: "~/.rules/olho/always-apply" }) overrides only the folder', () => {
    const merged = mergeConfig({ alwaysApplyFolder: "~/.rules/olho/always-apply" })
    expect(merged.enabled).toBe(true)
    expect(merged.alwaysApplyFolder).toBe("~/.rules/olho/always-apply")
  })

  test("mergeConfig overrides both fields at once", () => {
    const merged = mergeConfig({
      enabled: false,
      alwaysApplyFolder: "~/.rules/olho/always-apply",
    })
    expect(merged.enabled).toBe(false)
    expect(merged.alwaysApplyFolder).toBe("~/.rules/olho/always-apply")
  })

  test("mergeConfig does not mutate defaultConfig", () => {
    mergeConfig({ enabled: false, alwaysApplyFolder: "~/.rules/olho/always-apply" })
    expect(defaultConfig.enabled).toBe(true)
    expect(defaultConfig.alwaysApplyFolder).toBe("~/.rules/always-apply")
  })
})

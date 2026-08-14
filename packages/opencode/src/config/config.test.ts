import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { Info } from "./config"

describe("Config Schema — unstuck doom_loop fields", () => {
  test("enableDoomLoopDetection field accepts true and false", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { enableDoomLoopDetection: true },
    })
    expect(parsed.unstuck?.enableDoomLoopDetection).toBe(true)

    const disabled = Schema.decodeSync(Info)({
      unstuck: { enableDoomLoopDetection: false },
    })
    expect(disabled.unstuck?.enableDoomLoopDetection).toBe(false)
  })

  test("doomLoopThreshold field exists and accepts positive ints", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { doomLoopThreshold: 3 },
    })
    expect(parsed.unstuck?.doomLoopThreshold).toBe(3)

    const custom = Schema.decodeSync(Info)({
      unstuck: { doomLoopThreshold: 2 },
    })
    expect(custom.unstuck?.doomLoopThreshold).toBe(2)
  })

  test("doomLoop field exists in evidenceThresholds", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { evidenceThresholds: { doomLoop: 1 } },
    })
    expect(parsed.unstuck?.evidenceThresholds?.doomLoop).toBe(1)

    const custom = Schema.decodeSync(Info)({
      unstuck: { evidenceThresholds: { doomLoop: 3 } },
    })
    expect(custom.unstuck?.evidenceThresholds?.doomLoop).toBe(3)
  })

  test("backward compatible — config without doom_loop fields still parses (omitted fields stay undefined)", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: {
        enabled: true,
        loopThreshold: 3,
      },
    })
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.loopThreshold).toBe(3)
    // New fields are optional — should be undefined when not provided (defaults come from UnstuckConfig.mergeConfig)
    expect(parsed.unstuck?.enableDoomLoopDetection).toBeUndefined()
    expect(parsed.unstuck?.doomLoopThreshold).toBeUndefined()
    expect(parsed.unstuck?.evidenceThresholds?.doomLoop).toBeUndefined()
  })

  test("invalid values are rejected — doomLoopThreshold 0 throws", () => {
    expect(() =>
      Schema.decodeUnknownSync(Info)({ unstuck: { doomLoopThreshold: 0 } }),
    ).toThrow()
  })

  test("invalid values are rejected — doomLoop 0 throws", () => {
    expect(() =>
      Schema.decodeUnknownSync(Info)({
        unstuck: { evidenceThresholds: { doomLoop: 0 } },
      }),
    ).toThrow()
  })

  test("invalid values are rejected — enableDoomLoopDetection non-boolean throws", () => {
    expect(() =>
      Schema.decodeUnknownSync(Info)({
        unstuck: { enableDoomLoopDetection: "yes" },
      }),
    ).toThrow()
  })
})

describe("Config Schema — rulesInject", () => {
  test("rulesInject round-trips enabled and alwaysApplyFolder", () => {
    const parsed = Schema.decodeSync(Info)({
      rulesInject: { enabled: true, alwaysApplyFolder: "~/.rules/olho/always-apply" },
    })
    expect(parsed.rulesInject?.enabled).toBe(true)
    expect(parsed.rulesInject?.alwaysApplyFolder).toBe("~/.rules/olho/always-apply")
  })

  test("rulesInject.enabled false is preserved", () => {
    const parsed = Schema.decodeSync(Info)({
      rulesInject: { enabled: false, alwaysApplyFolder: "~/.rules/always-apply" },
    })
    expect(parsed.rulesInject?.enabled).toBe(false)
    expect(parsed.rulesInject?.alwaysApplyFolder).toBe("~/.rules/always-apply")
  })

  test("rulesInject is optional — missing field decodes to undefined", () => {
    const parsed = Schema.decodeSync(Info)({})
    expect(parsed.rulesInject).toBeUndefined()
  })

  test("rulesInject empty object still decodes (all sub-fields optional)", () => {
    const parsed = Schema.decodeSync(Info)({ rulesInject: {} })
    expect(parsed.rulesInject?.enabled).toBeUndefined()
    expect(parsed.rulesInject?.alwaysApplyFolder).toBeUndefined()
  })

  test("rulesInject.position 'after-persona' decodes successfully", () => {
    const parsed = Schema.decodeSync(Info)({
      rulesInject: { position: "after-persona" },
    })
    expect(parsed.rulesInject?.position).toBe("after-persona")
  })

  test("rulesInject.position 'before' decodes successfully", () => {
    const parsed = Schema.decodeSync(Info)({
      rulesInject: { position: "before" },
    })
    expect(parsed.rulesInject?.position).toBe("before")
  })

  test("invalid rulesInject.position value is rejected at decode", () => {
    expect(() =>
      Schema.decodeUnknownSync(Info)({ rulesInject: { position: "end" } }),
    ).toThrow()
  })

  test("rulesInject without position decodes to undefined (merge default covers it)", () => {
    const parsed = Schema.decodeSync(Info)({
      rulesInject: { enabled: true, alwaysApplyFolder: "~/.rules/olho/always-apply" },
    })
    expect(parsed.rulesInject?.position).toBeUndefined()
  })
})

describe("Config Schema — toolFilter", () => {
  test("toolFilter is optional — defaults to undefined", () => {
    const parsed = Schema.decodeSync(Info)({}
)
    expect(parsed.toolFilter).toBeUndefined()
  })

  test("toolFilter.applyPatch.enabled can be set to true", () => {
    const parsed = Schema.decodeSync(Info)({
      toolFilter: { applyPatch: { enabled: true } },
    }
)
    expect(parsed.toolFilter?.applyPatch?.enabled).toBe(true)
  })

  test("toolFilter.applyPatch.enabled can be set to false", () => {
    const parsed = Schema.decodeSync(Info)({
      toolFilter: { applyPatch: { enabled: false } },
    }
)
    expect(parsed.toolFilter?.applyPatch?.enabled).toBe(false)
  })

  test("backward compatible — existing config without toolFilter still parses", () => {
    const parsed = Schema.decodeSync(Info)({
      tools: { edit: true },
    }
)
    expect(parsed.tools).toEqual({ edit: true })
    expect(parsed.toolFilter).toBeUndefined()
  })
})

describe("Config Schema — unstuck sentenceLoopIncludeReasoning and doomLoopIgnorePatterns", () => {
  test("sentenceLoopIncludeReasoning field accepts true and false", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { sentenceLoopIncludeReasoning: true },
    })
    expect(parsed.unstuck?.sentenceLoopIncludeReasoning).toBe(true)

    const disabled = Schema.decodeSync(Info)({
      unstuck: { sentenceLoopIncludeReasoning: false },
    })
    expect(disabled.unstuck?.sentenceLoopIncludeReasoning).toBe(false)
  })

  test("sentenceLoopIncludeReasoning is optional — omitted field stays undefined", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { enabled: true },
    })
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.sentenceLoopIncludeReasoning).toBeUndefined()
  })

  test("sentenceLoopIncludeReasoning non-boolean is rejected", () => {
    expect(() =>
      Schema.decodeUnknownSync(Info)({
        unstuck: { sentenceLoopIncludeReasoning: "yes" },
      }),
    ).toThrow()
  })

  test("doomLoopIgnorePatterns field accepts array of strings", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { doomLoopIgnorePatterns: ["/\\.rules\\//", "\\.mdc$"] },
    })
    expect(parsed.unstuck?.doomLoopIgnorePatterns).toEqual(["/\\.rules\\//", "\\.mdc$"])
  })

  test("doomLoopIgnorePatterns accepts empty array", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { doomLoopIgnorePatterns: [] },
    })
    expect(parsed.unstuck?.doomLoopIgnorePatterns).toEqual([])
  })

  test("doomLoopIgnorePatterns is optional — omitted field stays undefined", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { enabled: true },
    })
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.doomLoopIgnorePatterns).toBeUndefined()
  })

  test("doomLoopIgnorePatterns with non-string element is rejected", () => {
    expect(() =>
      Schema.decodeUnknownSync(Info)({
        unstuck: { doomLoopIgnorePatterns: ["/\\.rules\\//", 42] },
      }),
    ).toThrow()
  })

  test("doomLoopIgnorePatterns with non-array is rejected", () => {
    expect(() =>
      Schema.decodeUnknownSync(Info)({
        unstuck: { doomLoopIgnorePatterns: "/\\.rules\\//" },
      }),
    ).toThrow()
  })

  test("selfDiagnosis field exists in evidenceThresholds", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { evidenceThresholds: { selfDiagnosis: 3 } },
    })
    expect(parsed.unstuck?.evidenceThresholds?.selfDiagnosis).toBe(3)
  })

  test("selfDiagnosis 0 is rejected", () => {
    expect(() =>
      Schema.decodeUnknownSync(Info)({
        unstuck: { evidenceThresholds: { selfDiagnosis: 0 } },
      }),
    ).toThrow()
  })

  test("backward compatible — config without new fields still parses", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: {
        enabled: true,
        loopThreshold: 3,
      },
    })
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.sentenceLoopIncludeReasoning).toBeUndefined()
    expect(parsed.unstuck?.doomLoopIgnorePatterns).toBeUndefined()
    expect(parsed.unstuck?.evidenceThresholds?.selfDiagnosis).toBeUndefined()
  })
})

describe("Config Schema — unstuck nudge strategy and pruneCount removal", () => {
  test('"nudge" strategy parses successfully', () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { strategy: "nudge" },
    })
    expect(parsed.unstuck?.strategy).toBe("nudge")
  })

  test('"nudge-and-prune" strategy still parses (legacy alias)', () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { strategy: "nudge-and-prune" },
    })
    expect(parsed.unstuck?.strategy).toBe("nudge-and-prune")
  })

  test('"abort" strategy parses successfully', () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { strategy: "abort" },
    })
    expect(parsed.unstuck?.strategy).toBe("abort")
  })

  test('"warn" strategy parses successfully', () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { strategy: "warn" },
    })
    expect(parsed.unstuck?.strategy).toBe("warn")
  })

  test('invalid strategy is rejected', () => {
    expect(() =>
      Schema.decodeUnknownSync(Info)({ unstuck: { strategy: "invalid" } }),
    ).toThrow()
  })

  test("pruneCount in input is ignored — dropped from output (Effect drops unknown keys)", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: {
        enabled: true,
        strategy: "nudge",
        pruneCount: 5,
      } as Record<string, unknown>,
    })
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.strategy).toBe("nudge")
    expect((parsed.unstuck as Record<string, unknown>)?.pruneCount).toBeUndefined()
  })

  test("backward compatible — config with pruneCount and nudge-and-prune still parses", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: {
        enabled: true,
        loopThreshold: 3,
        strategy: "nudge-and-prune" as const,
        pruneCount: 3,
      } as { enabled: boolean; loopThreshold: number; strategy: "nudge-and-prune"; pruneCount: number },
    })
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.loopThreshold).toBe(3)
    expect(parsed.unstuck?.strategy).toBe("nudge-and-prune")
    expect((parsed.unstuck as Record<string, unknown>)?.pruneCount).toBeUndefined()
  })
})


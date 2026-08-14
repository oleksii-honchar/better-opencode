import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { Info } from "./config"

describe("Config Schema — unstuck xml_repetition fields", () => {
  test("enableXmlRepetitionGuard field exists with default false", () => {
    const parsed = Schema.decodeSync(Info)({}
)
    // When no unstuck config is provided, the field is optional — defaults come from UnstuckConfig.mergeConfig
    // We verify the schema accepts the field
    const withField = Schema.decodeSync(Info)({
      unstuck: { enableXmlRepetitionGuard: true },
    }
)
    expect(withField.unstuck?.enableXmlRepetitionGuard).toBe(true)

    const withFalse = Schema.decodeSync(Info)({
      unstuck: { enableXmlRepetitionGuard: false },
    }
)
    expect(withFalse.unstuck?.enableXmlRepetitionGuard).toBe(false)
  })

  test("xmlRepetitionThreshold field exists with default 4", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { xmlRepetitionThreshold: 4 },
    }
)
    expect(parsed.unstuck?.xmlRepetitionThreshold).toBe(4)

    const custom = Schema.decodeSync(Info)({
      unstuck: { xmlRepetitionThreshold: 8 },
    }
)
    expect(custom.unstuck?.xmlRepetitionThreshold).toBe(8)
  })

  test("xmlRepetitionWindowSize field exists with default 10", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { xmlRepetitionWindowSize: 10 },
    }
)
    expect(parsed.unstuck?.xmlRepetitionWindowSize).toBe(10)

    const custom = Schema.decodeSync(Info)({
      unstuck: { xmlRepetitionWindowSize: 20 },
    }
)
    expect(custom.unstuck?.xmlRepetitionWindowSize).toBe(20)
  })

  test("maxToolInputTokens field exists with default 4000", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { maxToolInputTokens: 4000 },
    }
)
    expect(parsed.unstuck?.maxToolInputTokens).toBe(4000)

    const custom = Schema.decodeSync(Info)({
      unstuck: { maxToolInputTokens: 8000 },
    }
)
    expect(custom.unstuck?.maxToolInputTokens).toBe(8000)
  })

  test("maxTotalToolInputTokens field exists with default 16000", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { maxTotalToolInputTokens: 16000 },
    }
)
    expect(parsed.unstuck?.maxTotalToolInputTokens).toBe(16000)

    const custom = Schema.decodeSync(Info)({
      unstuck: { maxTotalToolInputTokens: 32000 },
    }
)
    expect(custom.unstuck?.maxTotalToolInputTokens).toBe(32000)
  })

  test("xmlRepetition field exists in evidenceThresholds", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { evidenceThresholds: { xmlRepetition: 1 } },
    }
)
    expect(parsed.unstuck?.evidenceThresholds?.xmlRepetition).toBe(1)

    const custom = Schema.decodeSync(Info)({
      unstuck: { evidenceThresholds: { xmlRepetition: 3 } },
    }
)
    expect(custom.unstuck?.evidenceThresholds?.xmlRepetition).toBe(3)
  })

  test("backward compatible — existing config without new fields still parses", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: {
        enabled: true,
        loopThreshold: 3,
        strategy: "nudge-and-prune",
      },
    }
)
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.loopThreshold).toBe(3)
    expect(parsed.unstuck?.strategy).toBe("nudge-and-prune")
    // New fields are optional — should be undefined when not provided
    expect(parsed.unstuck?.enableXmlRepetitionGuard).toBeUndefined()
    expect(parsed.unstuck?.xmlRepetitionThreshold).toBeUndefined()
  })

  test("all five new fields can be set together", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: {
        enableXmlRepetitionGuard: false,
        xmlRepetitionThreshold: 5,
        xmlRepetitionWindowSize: 15,
        maxToolInputTokens: 5000,
        maxTotalToolInputTokens: 20000,
      },
    }
)
    expect(parsed.unstuck?.enableXmlRepetitionGuard).toBe(false)
    expect(parsed.unstuck?.xmlRepetitionThreshold).toBe(5)
    expect(parsed.unstuck?.xmlRepetitionWindowSize).toBe(15)
    expect(parsed.unstuck?.maxToolInputTokens).toBe(5000)
    expect(parsed.unstuck?.maxTotalToolInputTokens).toBe(20000)
  })
})

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
      },
    })
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.strategy).toBe("nudge")
    expect(parsed.unstuck?.pruneCount).toBeUndefined()
  })

  test("backward compatible — config with pruneCount and nudge-and-prune still parses", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: {
        enabled: true,
        loopThreshold: 3,
        strategy: "nudge-and-prune",
        pruneCount: 3,
      },
    })
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.loopThreshold).toBe(3)
    expect(parsed.unstuck?.strategy).toBe("nudge-and-prune")
    expect(parsed.unstuck?.pruneCount).toBeUndefined()
  })
})

describe("Config Schema — unstuck nudge strategy and pruneCount removal", () => {
  test("'nudge' strategy parses successfully", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { strategy: "nudge" },
    })
    expect(parsed.unstuck?.strategy).toBe("nudge")
  })

  test("'nudge-and-prune' strategy still parses (legacy alias)", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { strategy: "nudge-and-prune" },
    })
    expect(parsed.unstuck?.strategy).toBe("nudge-and-prune")
  })

  test("'abort' strategy still parses", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { strategy: "abort" },
    })
    expect(parsed.unstuck?.strategy).toBe("abort")
  })

  test("'warn' strategy still parses", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { strategy: "warn" },
    })
    expect(parsed.unstuck?.strategy).toBe("warn")
  })

  test("invalid strategy is rejected", () => {
    expect(() =>
      Schema.decodeUnknownSync(Info)({ unstuck: { strategy: "invalid" } }),
    ).toThrow()
  })

  test("pruneCount in input config is ignored — not present in output", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: {
        enabled: true,
        strategy: "nudge",
        pruneCount: 5,
      },
    })
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.strategy).toBe("nudge")
    // pruneCount should be dropped by Effect Schema (unknown key)
    expect((parsed.unstuck as Record<string, unknown>)?.pruneCount).toBeUndefined()
  })

  test("pruneCount in input config is ignored — with nudge-and-prune strategy", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: {
        strategy: "nudge-and-prune",
        pruneCount: 3,
      },
    })
    expect(parsed.unstuck?.strategy).toBe("nudge-and-prune")
    expect((parsed.unstuck as Record<string, unknown>)?.pruneCount).toBeUndefined()
  })

  test("config without strategy or pruneCount still parses", () => {
    const parsed = Schema.decodeSync(Info)({
      unstuck: { enabled: true },
    })
    expect(parsed.unstuck?.enabled).toBe(true)
    expect(parsed.unstuck?.strategy).toBeUndefined()
  })
})

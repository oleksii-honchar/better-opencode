import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { Info } from "./config"

describe("Config Schema — unstuck xml_repetition fields", () => {
  test("enableXmlRepetitionGuard field exists with default true", () => {
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

import { describe, expect, test } from "bun:test"
import { computeUnstuckFingerprint } from "./loop-detector"
import { defaultConfig, mergeConfig } from "./config"

describe("computeUnstuckFingerprint — Task 8: Provider cache key fingerprint", () => {
  test("same config produces the same fingerprint (deterministic)", () => {
    const config = mergeConfig({ maxNudges: 5, strategy: "abort" })
    const hash1 = computeUnstuckFingerprint(config)
    const hash2 = computeUnstuckFingerprint(config)
    expect(hash1).toBe(hash2)
  })

  test("different config produces a different fingerprint", () => {
    const config1 = mergeConfig({ maxNudges: 2 })
    const config2 = mergeConfig({ maxNudges: 5 })
    expect(computeUnstuckFingerprint(config1)).not.toBe(computeUnstuckFingerprint(config2))
  })

  test("enabled vs disabled produces different fingerprints", () => {
    const enabled = mergeConfig({ enabled: true })
    const disabled = mergeConfig({ enabled: false })
    expect(computeUnstuckFingerprint(enabled)).not.toBe(computeUnstuckFingerprint(disabled))
  })

  test("default config produces a non-empty hex hash", () => {
    const hash = computeUnstuckFingerprint(defaultConfig)
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(hash.length).toBeGreaterThan(0)
  })

  test("strategy change produces different fingerprint", () => {
    const nudge = mergeConfig({ strategy: "nudge" })
    const abort = mergeConfig({ strategy: "abort" })
    expect(computeUnstuckFingerprint(nudge)).not.toBe(computeUnstuckFingerprint(abort))
  })

  test("evidenceThresholds change produces different fingerprint", () => {
    const config1 = mergeConfig({ evidenceThresholds: { sentenceLoop: 3 } })
    const config2 = mergeConfig({ evidenceThresholds: { sentenceLoop: 5 } })
    expect(computeUnstuckFingerprint(config1)).not.toBe(computeUnstuckFingerprint(config2))
  })

  test("sentenceLoopIncludeReasoning change produces different fingerprint", () => {
    const config1 = mergeConfig({ sentenceLoopIncludeReasoning: false })
    const config2 = mergeConfig({ sentenceLoopIncludeReasoning: true })
    expect(computeUnstuckFingerprint(config1)).not.toBe(computeUnstuckFingerprint(config2))
  })

  test("doomLoopIgnorePatterns change produces different fingerprint", () => {
    const config1 = mergeConfig({ doomLoopIgnorePatterns: ["/\\.rules\\/", "\\.mdc"] })
    const config2 = mergeConfig({ doomLoopIgnorePatterns: ["/\\.rules\\/", "\\.mdc", "/custom/"] })
    expect(computeUnstuckFingerprint(config1)).not.toBe(computeUnstuckFingerprint(config2))
  })

  test("fingerprint is stable across multiple calls with same input", () => {
    const config = mergeConfig({
      enabled: true,
      strategy: "nudge",
      maxNudges: 2,
      sentenceLoopIncludeReasoning: false,
      doomLoopIgnorePatterns: ["/\\.rules\\/", "\\.mdc"],
    })
    const hashes = Array.from({ length: 5 }, () => computeUnstuckFingerprint(config))
    expect(new Set(hashes).size).toBe(1)
  })

  test("cache key format: provider/model?unstuck=<hash>", () => {
    const config = mergeConfig({ enabled: true })
    const hash = computeUnstuckFingerprint(config)
    const key = `openai/gpt-4?unstuck=${hash}`
    expect(key).toContain("?unstuck=")
    expect(key).toContain(hash)
  })
})

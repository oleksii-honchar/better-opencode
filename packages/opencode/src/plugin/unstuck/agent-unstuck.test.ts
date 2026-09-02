import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3StreamPart, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import { resolveAgentUnstuckConfig } from "./config"
import { defaultConfig, mergeConfig, type UnstuckConfig } from "./config"
import { computeUnstuckFingerprint } from "./loop-detector"
import { wrapWithLoopDetection } from "./wrapper"

const COMPLIANCE_TEXT =
  "Persona Active and setup complete. The environment is initialized and ready to go."

describe("resolveAgentUnstuckConfig — agent block read + merged (agent precedence)", () => {
  test("agent unstuck block overrides global (enabled + fabricated opt-in + nested thresholds)", () => {
    const global = { enabled: false, loopThreshold: 5 } as Partial<UnstuckConfig>
    const agentBlock = {
      enabled: true,
      enableFabricatedComplianceDetection: true,
      evidenceThresholds: { fabricatedCompliance: 1 },
    }
    const resolved = resolveAgentUnstuckConfig(global, agentBlock)

    expect(resolved.enabled).toBe(true)
    expect(resolved.enableFabricatedComplianceDetection).toBe(true)
    expect(resolved.evidenceThresholds.fabricatedCompliance).toBe(1)
    // untouched global values preserved
    expect(resolved.loopThreshold).toBe(5)
    // nested thresholds not clobbered by the agent's partial evidenceThresholds
    expect(resolved.evidenceThresholds.doomLoop).toBe(defaultConfig.evidenceThresholds.doomLoop)
  })

  test("agent block reaches the wrapper: fabricated-compliance nudge fires for that agent's stream", async () => {
    const capturedPrompts: unknown[] = []
    const firstTurn: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "t1", delta: COMPLIANCE_TEXT },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" } },
    ] as any
    const nextTurn: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "t2", delta: "ok" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" } },
    ] as any

    let call = 0
    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        capturedPrompts.push(args.prompt)
        const chunks = call++ === 0 ? firstTurn : nextTurn
        let index = 0
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            pull(controller) {
              if (index >= chunks.length) {
                controller.close()
                return
              }
              controller.enqueue(chunks[index++])
            },
          }),
        }
      },
    }

    // What provider.getLanguage will resolve for an agent whose options carry the block
    const agentConfig = resolveAgentUnstuckConfig({ enabled: false }, {
      enabled: true,
      enableFabricatedComplianceDetection: true,
      evidenceThresholds: { fabricatedCompliance: 1 },
    })
    const wrapped = wrapWithLoopDetection(model, agentConfig)

    const streamResult = await wrapped.doStream({ prompt: [] } as LanguageModelV3CallOptions)
    const reader = streamResult.stream.getReader()
    const chunks: LanguageModelV3StreamPart[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    reader.releaseLock()

    expect(chunks.length).toBeGreaterThan(0)
    expect(capturedPrompts.length).toBe(2)
    const nudged = capturedPrompts[1] as Array<{ role: string; content: unknown }>
    expect(nudged[nudged.length - 1].role).toBe("user")
    expect(JSON.stringify(nudged[nudged.length - 1].content).toLowerCase()).toContain("without calling tools")
  })

  test("fingerprint differs when only enableFabricatedComplianceDetection differs (per-agent cache keys)", () => {
    const off = mergeConfig({})
    const on = mergeConfig({ enableFabricatedComplianceDetection: true })
    expect(computeUnstuckFingerprint(off)).not.toBe(computeUnstuckFingerprint(on))
  })
})

describe("resolveAgentUnstuckConfig — agents without the block unchanged", () => {
  test("no global, no agent block → exactly defaultConfig", () => {
    expect(resolveAgentUnstuckConfig(undefined, undefined)).toEqual(defaultConfig)
    expect(resolveAgentUnstuckConfig(undefined, undefined).enableFabricatedComplianceDetection).toBe(false)
  })

  test("global only (agent has no unstuck key in options) → mergeConfig(global) semantics", () => {
    const global = { loopThreshold: 7, evidenceThresholds: { doomLoop: 5 } } as Partial<UnstuckConfig>
    expect(resolveAgentUnstuckConfig(global, undefined)).toEqual(mergeConfig(global))
    expect(resolveAgentUnstuckConfig(global, undefined).loopThreshold).toBe(7)
    expect(resolveAgentUnstuckConfig(global, undefined).evidenceThresholds.doomLoop).toBe(5)
    expect(resolveAgentUnstuckConfig(global, undefined).enableFabricatedComplianceDetection).toBe(false)
  })
})

describe("resolveAgentUnstuckConfig — invalid shapes ignored defensively", () => {
  test("non-object agent block → global-only", () => {
    expect(resolveAgentUnstuckConfig(undefined, "enabled")).toEqual(defaultConfig)
    expect(resolveAgentUnstuckConfig(undefined, 42)).toEqual(defaultConfig)
    expect(resolveAgentUnstuckConfig(undefined, null)).toEqual(defaultConfig)
    expect(resolveAgentUnstuckConfig(undefined, [true])).toEqual(defaultConfig)
  })

  test("wrong-typed fields dropped, valid fields kept", () => {
    const resolved = resolveAgentUnstuckConfig(undefined, {
      enabled: "yes",
      loopThreshold: "3",
      enableFabricatedComplianceDetection: true,
      strategy: "explode",
      evidenceThresholds: { fabricatedCompliance: "1", doomLoop: 4 },
    })
    expect(resolved.enabled).toBe(defaultConfig.enabled)
    expect(resolved.loopThreshold).toBe(defaultConfig.loopThreshold)
    expect(resolved.enableFabricatedComplianceDetection).toBe(true)
    expect(resolved.strategy).toBe(defaultConfig.strategy)
    expect(resolved.evidenceThresholds.fabricatedCompliance).toBe(defaultConfig.evidenceThresholds.fabricatedCompliance)
    expect(resolved.evidenceThresholds.doomLoop).toBe(4)
  })

  test("unknown keys dropped, no prototype pollution", () => {
    const resolved = resolveAgentUnstuckConfig(undefined, {
      enabled: true,
      __proto__: { evil: true },
      evil: true,
    } as Record<string, unknown>)
    expect((resolved as unknown as Record<string, unknown>).evil).toBeUndefined()
    expect(resolved.enabled).toBe(true)
  })
})

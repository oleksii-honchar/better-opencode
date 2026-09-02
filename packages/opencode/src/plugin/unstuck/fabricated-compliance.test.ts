import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3StreamPart, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import { LoopDetectorImpl, EvidenceAccumulatorImpl, type StreamChunk } from "./loop-detector"
import { defaultConfig, mergeConfig, type UnstuckConfig } from "./config"
import { wrapWithLoopDetection } from "./wrapper"

const COMPLIANCE_TEXT =
  "Persona Active and setup complete. The environment is initialized and ready to go."

function fabricatedConfig(): UnstuckConfig {
  return {
    ...defaultConfig,
    loopThreshold: 10,
    detectToolOnlyLoops: false,
    enableFabricatedComplianceDetection: true,
    evidenceThresholds: { ...defaultConfig.evidenceThresholds, fabricatedCompliance: 1 },
  }
}

describe("fabricated_compliance — detector", () => {
  test("compliance-claim text with ZERO tool parts in the turn → fabricated_compliance detected", () => {
    const detector = new LoopDetectorImpl()
    const config = fabricatedConfig()

    detector.consumeChunk({ type: "text-delta", text: COMPLIANCE_TEXT }, config)
    const result = detector.finalizeStep(config, "stop")

    expect(result).toBeDefined()
    expect(result?.type).toBe("fabricated_compliance")
    expect(result?.threshold).toBe(1)
  })

  test("same compliance-claim text WITH tool parts in the turn → NOT detected", () => {
    const detector = new LoopDetectorImpl()
    const config = fabricatedConfig()

    detector.consumeChunk({ type: "text-delta", text: COMPLIANCE_TEXT }, config)
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "bash", input: { command: "ls" } },
      config,
    )
    const result = detector.finalizeStep(config, "tool-calls")

    expect(result).toBeUndefined()
  })

  test("detection is config-gated and DEFAULT OFF — no detection, no evidence under defaultConfig", () => {
    expect(defaultConfig.enableFabricatedComplianceDetection).toBe(false)

    const detector = new LoopDetectorImpl()
    const acc = new EvidenceAccumulatorImpl()

    detector.consumeChunk({ type: "text-delta", text: COMPLIANCE_TEXT }, defaultConfig)
    const result = detector.finalizeStep(defaultConfig, "stop")
    if (result) acc.add(result, 1, defaultConfig)

    expect(result).toBeUndefined()
    expect(acc.isThresholdMet(defaultConfig).met).toBe(false)
  })

  test("mergeConfig keeps default OFF when agent config does not opt in", () => {
    const merged = mergeConfig({})
    expect(merged.enableFabricatedComplianceDetection).toBe(false)
  })

  test("mergeConfig passes the opt-in through from agent config", () => {
    const merged = mergeConfig({ enableFabricatedComplianceDetection: true } as Partial<UnstuckConfig>)
    expect(merged.enableFabricatedComplianceDetection).toBe(true)
  })

  test("evidence gate: single fabricated_compliance detection at threshold 1 meets intervention", () => {
    const config = fabricatedConfig()
    const detector = new LoopDetectorImpl()
    const acc = new EvidenceAccumulatorImpl()

    detector.consumeChunk({ type: "text-delta", text: COMPLIANCE_TEXT }, config)
    const result = detector.finalizeStep(config, "stop")
    if (result) acc.add(result, 1, config)

    const met = acc.isThresholdMet(config)
    expect(met.met).toBe(true)
    expect((met as { met: true; type: string }).type).toBe("fabricated_compliance")
  })
})

describe("fabricated_compliance — wrapper queues next-turn nudge", () => {
  function createCallCountingMockModel(
    callsChunks: LanguageModelV3StreamPart[][],
    capturedPrompts: unknown[],
  ): LanguageModelV3 {
    let call = 0
    return {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        capturedPrompts.push(args.prompt)
        const chunks = callsChunks[Math.min(call, callsChunks.length - 1)]
        call++
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
  }

  async function collectStream(model: LanguageModelV3): Promise<LanguageModelV3StreamPart[]> {
    const result: LanguageModelV3StreamPart[] = []
    const streamResult = await model.doStream({ prompt: [] } as LanguageModelV3CallOptions)
    const reader = streamResult.stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        result.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return result
  }

  test("compliance text + zero tools → nudge with verification text queued for the next turn", async () => {
    const capturedPrompts: unknown[] = []
    const firstTurn: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "t1", delta: COMPLIANCE_TEXT },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" } },
    ] as any
    const nextTurn: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "t2", delta: "ok" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" } },
    ] as any

    const model = createCallCountingMockModel([firstTurn, nextTurn], capturedPrompts)
    const config = mergeConfig({
      ...fabricatedConfig(),
      nudgeMessage: undefined,
    } as Partial<UnstuckConfig>)
    const wrapped = wrapWithLoopDetection(model, config)

    const chunks = await collectStream(wrapped)
    expect(chunks.length).toBeGreaterThan(0)

    // Nudge restarts the stream with an injected user message for the next turn
    expect(capturedPrompts.length).toBe(2)
    const nudgedPrompt = capturedPrompts[1] as Array<{ role: string; content: unknown }>
    const nudgeMsg = nudgedPrompt[nudgedPrompt.length - 1]
    expect(nudgeMsg.role).toBe("user")
    const text = JSON.stringify(nudgeMsg.content)
    expect(text.toLowerCase()).toContain("without calling tools")
  })

  test("compliance text WITH tool parts → no nudge queued (single doStream call)", async () => {
    const capturedPrompts: unknown[] = []
    const withTools: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "t1", delta: COMPLIANCE_TEXT },
      { type: "tool-input-start", id: "c0", toolName: "bash" },
      { type: "tool-input-end", id: "c0", providerMetadata: undefined },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } },
    ] as any

    const model = createCallCountingMockModel([withTools], capturedPrompts)
    const wrapped = wrapWithLoopDetection(model, fabricatedConfig())

    await collectStream(wrapped)
    expect(capturedPrompts.length).toBe(1)
  })
})

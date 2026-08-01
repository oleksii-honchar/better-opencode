import { describe, expect, spyOn, test } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import type { LanguageModelV3, LanguageModelV3StreamPart, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import { LoopDetectorImpl, type LoopDetector } from "./loop-detector"
import { wrapWithLoopDetection } from "./wrapper"
import { defaultConfig, type UnstuckConfig } from "./config"
import { LoopDetectedError, type LoopDetectedInfo } from "./error"

function createMockStream(chunks: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  let index = 0
  return new ReadableStream<LanguageModelV3StreamPart>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index++])
    },
  })
}

function createMockModel(chunks: LanguageModelV3StreamPart[]): LanguageModelV3 {
  return {
    modelId: "test-model",
    provider: "test",
    specificationVersion: "v3",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented")
    },
    async doStream(): Promise<LanguageModelV3StreamResult> {
      return { stream: createMockStream(chunks) }
    },
  }
}

const mockUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
} as const

async function collectStream(
  model: LanguageModelV3,
  prompt: Array<{ role: string; content: string | unknown }> = [],
): Promise<LanguageModelV3StreamPart[]> {
  const result: LanguageModelV3StreamPart[] = []
  const streamResult = await model.doStream({ prompt: prompt as any } as LanguageModelV3CallOptions)
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

async function expectThrowsLoopDetected(fn: () => Promise<any>): Promise<void> {
  let threw = false
  let error: unknown = undefined
  try {
    await fn()
  } catch (e) {
    threw = true
    error = e
  }
  expect(threw).toBe(true)
  expect(error).toBeInstanceOf(LoopDetectedError)
}

describe("wrapWithLoopDetection — no loop", () => {
  test("passes through chunks when no loop is detected", async () => {
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "1", delta: "Hello" },
      { type: "text-delta", id: "1", delta: " world" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model = createMockModel(chunks)
    const detector = new LoopDetectorImpl()
    const wrapped = wrapWithLoopDetection(model, detector, defaultConfig)

    const result = await collectStream(wrapped)
    expect(result).toEqual(chunks)
  })
})

describe("wrapWithLoopDetection — step-level loop", () => {
  test("throws LoopDetectedError on step-level loop", async () => {
    const chunks: LanguageModelV3StreamPart[] = []

    for (let i = 0; i < 3; i++) {
      chunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      chunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      chunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    const model = createMockModel(chunks)
    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    await expectThrowsLoopDetected(() => collectStream(wrapped))
  })
})

describe("wrapWithLoopDetection — strategy: warn", () => {
  test("rethrows LoopDetectedError without nudge-and-prune", async () => {
    const chunks: LanguageModelV3StreamPart[] = []

    for (let i = 0; i < 3; i++) {
      chunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      chunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      chunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    const model = createMockModel(chunks)
    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, strategy: "warn" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    await expectThrowsLoopDetected(() => collectStream(wrapped))
  })
})

describe("wrapWithLoopDetection — strategy: abort", () => {
  test("rethrows LoopDetectedError without nudge-and-prune", async () => {
    const chunks: LanguageModelV3StreamPart[] = []

    for (let i = 0; i < 3; i++) {
      chunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      chunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      chunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    const model = createMockModel(chunks)
    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    await expectThrowsLoopDetected(() => collectStream(wrapped))
  })
})

describe("wrapWithLoopDetection — disabled", () => {
  test("passes through all chunks when disabled", async () => {
    const chunks: LanguageModelV3StreamPart[] = []

    for (let i = 0; i < 3; i++) {
      chunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      chunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      chunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    const model = createMockModel(chunks)
    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, enabled: false }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    const result = await collectStream(wrapped)
    expect(result).toEqual(chunks)
  })
})

describe("wrapWithLoopDetection — nudge-and-prune", () => {
  test("prunes assistant messages and injects nudge after evidence threshold", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      loopingChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      loopingChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      loopingChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "recovery-text", delta: "Recovery response" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        receivedPrompt = args.prompt
        // Call 1: loop → evidence=1, below threshold → restart with same args
        // Call 2: loop → evidence=2, threshold met → nudge
        // Call 3: recovery
        if (callCount <= 2) {
          return { stream: createMockStream(loopingChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 2, pruneCount: 2, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    const initialMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First response" },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "Second response" },
      { role: "assistant", content: "Third response" },
    ]

    const result = await collectStream(wrapped, initialMessages)

    // Should have yielded chunks from all 3 streams
    expect(result.length).toBeGreaterThan(0)

    // Should have called doStream 3 times (original + below-threshold restart + nudge)
    expect(callCount).toBe(3)

    // Third call should have pruned 2 assistant messages and injected nudge
    expect(receivedPrompt.length).toBe(initialMessages.length - 2 + 1) // -2 pruned + 1 nudge
    expect(receivedPrompt[receivedPrompt.length - 1].role).toBe("user")
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    expect(lastContent[0]?.text).toContain("stuck in a loop")
  })
})

describe("wrapWithLoopDetection — max nudges exceeded", () => {
  test("falls back to abort after max nudges", async () => {
    let callCount = 0

    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      loopingChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      loopingChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      loopingChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(loopingChunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 1, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    await expectThrowsLoopDetected(() => collectStream(wrapped, [{ role: "user", content: "Hello" }]))

    // With evidence accumulation:
    // Stream 1: detection → ev=1, below threshold → restart
    // Stream 2: detection → ev=2, threshold met → nudge #1 → evidence cleared
    // Stream 3: detection → ev=1, below threshold → restart
    // Stream 4: detection → ev=2, threshold met → would nudge but maxNudges reached → abort
    expect(callCount).toBe(4)
  })
})

describe("defaultNudgeMessage — xml_repetition", () => {
  test("produces context-aware nudge with tag name and tool name", async () => {
    // When xml_repetition is detected with xmlTag and toolName,
    // the nudge message should reference the specific tag and tool
    let callCount = 0
    let receivedPrompt: any[] = []

    // Simulate xml_repetition detection via tool-input-delta with repeated XML tags
    const xmlRepetitionChunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-0", toolName: "ReadFile" },
    ]
    // Feed enough identical XML tags to trigger xml_repetition (threshold=4)
    for (let i = 0; i < 5; i++) {
      xmlRepetitionChunks.push({ type: "tool-input-delta", id: "call-0", delta: "<parameter>value</parameter>" })
    }

    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "recovery-text", delta: "Recovery response" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        receivedPrompt = args.prompt as any[]
        if (callCount === 1) {
          return { stream: createMockStream(xmlRepetitionChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = {
      ...defaultConfig,
      maxNudges: 2,
      strategy: "nudge-and-prune",
      enableXmlRepetitionGuard: true,
      xmlRepetitionThreshold: 4,
      xmlRepetitionWindowSize: 10,
      maxToolInputTokens: 4000,
      maxTotalToolInputTokens: 16000,
      detectToolOnlyLoops: false,
      loopThreshold: 10,
      nudgeMessage: undefined,
    }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    // Should have called doStream twice (original + nudge)
    expect(callCount).toBe(2)

    // The nudge message should reference the specific tag and tool
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    expect(lastContent[0]?.text).toContain("parameter")
    expect(lastContent[0]?.text).toContain("ReadFile")
    expect(lastContent[0]?.text).toContain("schema")
  })
})

describe("wrapWithLoopDetection — xml_repetition thresholdKey mapping", () => {
  test("xml_repetition uses xmlRepetition thresholdKey when below threshold", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    // Simulate xml_repetition detection via tool-input-delta with repeated XML tags
    const xmlRepetitionChunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-0", toolName: "ReadFile" },
    ]
    // Feed enough identical XML tags to trigger xml_repetition (threshold=4)
    for (let i = 0; i < 5; i++) {
      xmlRepetitionChunks.push({ type: "tool-input-delta", id: "call-0", delta: "<parameter>value</parameter>" })
    }

    // Recovery chunks — clean finish
    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "recovery-text", delta: "Recovery response" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        receivedPrompt = args.prompt as any[]
        // Call 1: xml_repetition detected, evidence=1, below custom threshold=2 → restart
        // Call 2: recovery (no loop)
        if (callCount === 1) {
          return { stream: createMockStream(xmlRepetitionChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    // Set xmlRepetition threshold to 2 so 1 detection is below threshold
    const config: UnstuckConfig = {
      ...defaultConfig,
      maxNudges: 2,
      strategy: "nudge-and-prune",
      enableXmlRepetitionGuard: true,
      xmlRepetitionThreshold: 4,
      xmlRepetitionWindowSize: 10,
      maxToolInputTokens: 4000,
      maxTotalToolInputTokens: 16000,
      detectToolOnlyLoops: false,
      loopThreshold: 10,
      evidenceThresholds: { ...defaultConfig.evidenceThresholds, xmlRepetition: 2 },
    }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    const initialMessages = [{ role: "user", content: "Hello" }]
    await collectStream(wrapped, initialMessages)

    // Should have called doStream twice (original + restart below threshold)
    expect(callCount).toBe(2)

    // Second call should use original args (no nudge injected — below threshold)
    expect(receivedPrompt).toEqual(initialMessages)
  })
})

describe("wrapWithLoopDetection — evidence accumulation", () => {
  test("below threshold — continues stream without nudge", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    // First call: produces loop detection
    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      loopingChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      loopingChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      loopingChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    // Second call (after restart below threshold): finishes normally
    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "recovery-text", delta: "Recovery response" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        receivedPrompt = args.prompt as any[]
        const chunks = callCount === 1 ? loopingChunks : recoveryChunks
        return { stream: createMockStream(chunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    // stepLoop threshold is 2, so 1 detection should not trigger nudge
    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 2, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    const initialMessages = [{ role: "user", content: "Hello" }]

    const result = await collectStream(wrapped, initialMessages)

    // Should have looping chunks + recovery chunks (looping chunks yielded before detection)
    expect(result.length).toBe(loopingChunks.length + recoveryChunks.length - 1)

    // Should have called doStream twice (original + restart below threshold)
    expect(callCount).toBe(2)

    // Second call should use original args (no nudge injected)
    expect(receivedPrompt).toEqual(initialMessages)
  })

  test("threshold met — nudge fires on second detection", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    // First call: produces loop detection (evidence=1, below threshold=2)
    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      loopingChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      loopingChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      loopingChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    // Second call (after restart below threshold): also produces loop detection (evidence=2, threshold met)
    // Third call (after nudge): finishes normally
    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "recovery-text", delta: "Recovery response" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        receivedPrompt = args.prompt as any[]
        // Call 1: loop → evidence=1, below threshold → restart
        // Call 2: loop → evidence=2, threshold met → nudge
        // Call 3: recovery
        if (callCount <= 2) {
          return { stream: createMockStream(loopingChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 2, pruneCount: 1, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    const initialMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Response" },
    ]

    const result = await collectStream(wrapped, initialMessages)

    // Should have yielded chunks from all 3 streams
    expect(result.length).toBeGreaterThan(0)

    // Should have called doStream 3 times
    expect(callCount).toBe(3)

    // Third call should have nudged messages (pruned + nudge injected)
    expect(receivedPrompt.length).toBeGreaterThan(initialMessages.length - 1) // pruned 1 + added nudge
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    expect(lastContent[0]?.text).toContain("stuck in a loop")
  })

  test("sentence loop triggers immediately (threshold=1)", async () => {
    let callCount = 0

    // Sentence loop chunks — the sentence tracker detects repetition within a single stream
    const sentenceLoopChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "1", delta: "This is a repeated sentence that appears multiple times. " },
      { type: "text-delta", id: "1", delta: "Some other text in between to separate the sentences. " },
      { type: "text-delta", id: "1", delta: "This is a repeated sentence that appears multiple times. " },
      { type: "text-delta", id: "1", delta: "Some other text in between to separate the sentences. " },
      { type: "text-delta", id: "1", delta: "This is a repeated sentence that appears multiple times. " },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        // First call: sentence loop detected, threshold=1 → immediate nudge
        // Second call: recovery
        if (callCount === 1) {
          return { stream: createMockStream(sentenceLoopChunks) }
        }
        return { stream: createMockStream([{ type: "text-delta", id: "recovery", delta: "OK" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage }]) }
      },
    }

    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 2, strategy: "nudge-and-prune", sentenceLoopThreshold: 3, minSentenceLength: 10 }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    // Should have called doStream twice (original + nudge)
    expect(callCount).toBe(2)
  })

  test("max nudges aborts after evidence threshold nudges fail", async () => {
    let callCount = 0

    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      loopingChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      loopingChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      loopingChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(loopingChunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    // maxNudges=1, stepLoop threshold=2
    // Stream 1: detection → ev=1, continue → detection → ev=2, nudge #1 → evidence cleared, detector cleared
    // Stream 2: detection → ev=1, continue → detection → ev=2, would nudge but maxNudges reached → abort
    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 1, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    await expectThrowsLoopDetected(() => collectStream(wrapped, [{ role: "user", content: "Hello" }]))

    // Should have tried multiple streams before aborting
    expect(callCount).toBeGreaterThan(1)
  })

  test("evidence is cleared on clean finish but detector history is preserved", async () => {
    let callCount = 0

    // First call: produces loop detection (evidence=1, below threshold=2)
    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      loopingChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      loopingChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      loopingChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    // Second call (after restart below threshold): finishes normally — evidence should be cleared
    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "recovery-text", delta: "Recovery response" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        const chunks = callCount === 1 ? loopingChunks : recoveryChunks
        return { stream: createMockStream(chunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 2, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    const result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    // Stream completes normally — no nudge fired
    expect(result.length).toBe(loopingChunks.length + recoveryChunks.length - 1)
    expect(callCount).toBe(2)

    // After clean finish, evidence is cleared but detector history is preserved
    // (detector.clear() was removed from the clean-completion path)
    expect(detector.getState().historyLength).toBeGreaterThan(0)
  })

  test("cross-stream history preservation — detector accumulates across streams", async () => {
    let callCount = 0

    // Both streams produce the same tool call (no thinking text — tool-only detection)
    const toolChunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-1", toolName: "ReadFile" },
      {
        type: "tool-input-end",
        id: "call-1",
        input: { path: "/some/file.txt" },
        providerMetadata: undefined,
      } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(toolChunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    // Use a low toolLoopThreshold so we can see accumulation with just 2 streams
    const config: UnstuckConfig = { ...defaultConfig, toolLoopThreshold: 2, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    // First stream — should complete normally, history grows to 1
    const result1 = await collectStream(wrapped, [{ role: "user", content: "Hello" }])
    expect(result1.length).toBe(toolChunks.length)
    expect(detector.getState().historyLength).toBe(1)

    // Second stream with same tool call — should now trigger tool_loop detection
    // because history accumulates across streams (detector.clear() not called on clean finish)
    await expectThrowsLoopDetected(() => collectStream(wrapped, [{ role: "user", content: "Hello" }]))

    // After detection, history should have 2 entries (both streams contributed)
    expect(detector.getState().historyLength).toBe(2)
  })
})

describe("wrapWithLoopDetection — new user message resets state", () => {
  test("detector.clear() resets all state — historyLength=0, currentReasoningLength=0, currentToolsCount=0", () => {
    const detector = new LoopDetectorImpl()

    // Seed history by manually pushing via finalizeStep
    detector.consumeChunk(
      { type: "tool-input-start", id: "call-1", toolName: "ReadFile" },
      defaultConfig,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/test" } },
      defaultConfig,
    )
    detector.finalizeStep(defaultConfig, "tool-calls")

    expect(detector.getState().historyLength).toBe(1)

    // Clear
    detector.clear()

    expect(detector.getState().historyLength).toBe(0)
    expect(detector.getState().currentReasoningLength).toBe(0)
    expect(detector.getState().currentToolsCount).toBe(0)
  })

  test("evidence.clear() removes all records — evidence.count === 0", () => {
    const { EvidenceAccumulatorImpl } = require("./loop-detector")
    const ev = new EvidenceAccumulatorImpl()

    expect(ev.count).toBe(0)

    ev.add({ type: "step_loop", threshold: 3 }, 10, defaultConfig)
    ev.add({ type: "step_loop", threshold: 3 }, 20, defaultConfig)

    expect(ev.count).toBe(2)

    ev.clear()

    expect(ev.count).toBe(0)
  })

  test("new user message triggers reset of detector, evidence, and nudgeCount", async () => {
    let callCount = 0

    // Simple clean chunks that accumulate history without triggering loops
    const cleanChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "1", delta: "Clean response" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(cleanChunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    // First call — 1 user message
    await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    // After first call, detector has history (1 step)
    expect(detector.getState().historyLength).toBe(1)

    // Second call — 2 user messages (new user message detected → should reset)
    await collectStream(wrapped, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Previous response" },
      { role: "user", content: "New message" },
    ])

    // After second call, detector should have been reset at start (new user message)
    // then accumulated 1 step from cleanChunks
    // Without the fix: historyLength = 2 (accumulated, not reset)
    // With the fix: historyLength = 1 (reset then 1 new step)
    expect(detector.getState().historyLength).toBe(1)
  })

  test("tool response messages do NOT trigger reset", async () => {
    let callCount = 0

    const cleanChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "1", delta: "Clean response" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(cleanChunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    // First call — 1 user message
    await collectStream(wrapped, [{ role: "user", content: "Hello" }])
    const historyAfterFirst = detector.getState().historyLength

    // Second call — same 1 user message + tool response (no new user message)
    await collectStream(wrapped, [
      { role: "user", content: "Hello" },
      { role: "tool", content: "Tool output" },
    ])

    // History should have accumulated (not reset) — 2 steps total
    expect(detector.getState().historyLength).toBe(historyAfterFirst + 1)
  })

  test("nudge messages do NOT trigger reset", async () => {
    let callCount = 0

    const cleanChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "1", delta: "Clean response" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(cleanChunks) }
      },
    }

    const detector = new LoopDetectorImpl()
    const config: UnstuckConfig = { ...defaultConfig, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, detector, config)

    // First call — 1 user message
    await collectStream(wrapped, [{ role: "user", content: "Hello" }])
    const historyAfterFirst = detector.getState().historyLength

    // Second call — same 1 user message + nudge message (nudge excluded from count)
    await collectStream(wrapped, [
      { role: "user", content: "Hello" },
      { role: "user", content: { type: "text", text: "nudge" }, _unstuckNudge: true } as any,
    ])

    // History should have accumulated (not reset) — nudge doesn't count as new user message
    expect(detector.getState().historyLength).toBe(historyAfterFirst + 1)
  })
})

describe("wrapWithLoopDetection — doom_loop nudge and logs", () => {
  function getUnstuckLogger() {
    return Log.create({ service: "unstuck-plugin" })
  }

  function doomLoopChunks(count = 3, toolName = "bash", input: Record<string, unknown> = { command: "ls -la" }): LanguageModelV3StreamPart[] {
    const chunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < count; i++) {
      chunks.push({ type: "text-delta", id: `${i}-text`, delta: "Doom loop thinking" })
      chunks.push({ type: "tool-input-start", id: `call-${i}`, toolName })
      chunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        input,
        providerMetadata: undefined,
      } as any)
    }
    chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    return chunks
  }

  const recoveryChunks: LanguageModelV3StreamPart[] = [
    { type: "text-delta", id: "recovery-text", delta: "Recovery response" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
  ]

  // Disable unrelated detectors so only doom_loop fires.
  // nudgeMessage: undefined routes through defaultNudgeMessage (the doom_loop branch),
  // matching the established xml_repetition test pattern.
  const doomConfig: UnstuckConfig = {
    ...defaultConfig,
    maxNudges: 2,
    strategy: "nudge-and-prune",
    loopThreshold: 100,
    detectToolOnlyLoops: false,
    enablePatternLoopDetection: false,
    enableSentenceLoopDetection: false,
    enableSelfDiagnosisDetection: false,
    enableXmlRepetitionGuard: false,
    nudgeMessage: undefined,
  }

  function createDoomModel(loopChunks: LanguageModelV3StreamPart[]): { model: LanguageModelV3; callCount: () => number; receivedPrompt: () => any[] } {
    let callCount = 0
    let receivedPrompt: any[] = []
    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        receivedPrompt = args.prompt as any[]
        // Call 1: doom loop detected → threshold met (doomLoop=1) → nudge
        // Call 2: recovery
        if (callCount === 1) {
          return { stream: createMockStream(loopChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }
    return {
      model,
      callCount: () => callCount,
      receivedPrompt: () => receivedPrompt,
    }
  }

  test("doom_loop detection with threshold met triggers a nudge naming the tool", async () => {
    const { model, callCount, receivedPrompt } = createDoomModel(doomLoopChunks())
    const detector = new LoopDetectorImpl()
    const wrapped = wrapWithLoopDetection(model, detector, doomConfig)

    const result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    expect(result.length).toBeGreaterThan(0)
    expect(callCount()).toBe(2)

    const lastContent = receivedPrompt()[receivedPrompt().length - 1].content as Array<{ type: string; text: string }>
    expect(receivedPrompt()[receivedPrompt().length - 1]._unstuckNudge).toBe(true)
    expect(lastContent[0]?.text).toContain("bash")
    expect(lastContent[0]?.text).toContain("doom loop")
  })

  test("doom_loop nudge without toolName falls back to generic guidance without crashing", async () => {
    // Stub detector that reports doom_loop with NO toolName
    let fired = false
    const stubDetector: LoopDetector = {
      consumeChunk() {
        if (!fired) {
          fired = true
          return { type: "doom_loop", threshold: 3 } satisfies LoopDetectedInfo
        }
        return undefined
      },
      finalizeStep() {
        return undefined
      },
      reset() {},
      clear() {},
      getState() {
        return {
          currentReasoningLength: 0,
          currentTextLength: 0,
          currentThinkingLength: 0,
          currentToolsCount: 0,
          historyLength: 0,
          inReasoning: false,
        }
      },
    }

    const { model, callCount, receivedPrompt } = createDoomModel([
      { type: "text-delta", id: "1", delta: "Doom loop thinking" },
      { type: "tool-input-start", id: "call-1", toolName: "bash" },
      { type: "tool-input-end", id: "call-1", input: { command: "ls -la" }, providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },
    ])
    const wrapped = wrapWithLoopDetection(model, stubDetector, doomConfig)

    const result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    expect(result.length).toBeGreaterThan(0)
    expect(callCount()).toBe(2)

    const lastContent = receivedPrompt()[receivedPrompt().length - 1].content as Array<{ type: string; text: string }>
    expect(receivedPrompt()[receivedPrompt().length - 1]._unstuckNudge).toBe(true)
    expect(lastContent[0]?.text).toContain("doom loop")
    expect(lastContent[0]?.text).not.toContain("tool '")
  })

  test("thresholdKey maps doom_loop → doomLoop (evidence below threshold reads config.evidenceThresholds.doomLoop)", async () => {
    const logger = getUnstuckLogger()
    const infoSpy = spyOn(logger, "info")
    try {
      let callCount = 0
      let receivedPrompt: any[] = []

      const model: LanguageModelV3 = {
        modelId: "test-model",
        provider: "test",
        specificationVersion: "v3",
        supportedUrls: {},
        async doGenerate() {
          throw new Error("not implemented")
        },
        async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
          callCount++
          receivedPrompt = args.prompt as any[]
          // Call 1: doom loop detected, evidence doom_loop=1, below doomLoop threshold=2 → restart
          // Call 2: recovery (no loop)
          if (callCount === 1) {
            return { stream: createMockStream(doomLoopChunks()) }
          }
          return { stream: createMockStream(recoveryChunks) }
        },
      }

      const detector = new LoopDetectorImpl()
      // doomLoop=2 so the first detection is below threshold. stepLoop=99 ensures the
      // fallback thresholdKey ("stepLoop") would NOT match — proving doomLoop is read.
      const config: UnstuckConfig = {
        ...doomConfig,
        evidenceThresholds: {
          ...defaultConfig.evidenceThresholds,
          stepLoop: 99,
          toolLoop: 99,
          sentenceLoop: 99,
          selfDiagnosis: 99,
          patternLoop: 99,
          xmlRepetition: 99,
          doomLoop: 2,
        },
      }
      const wrapped = wrapWithLoopDetection(model, detector, config)

      const initialMessages = [{ role: "user", content: "Hello" }]
      await collectStream(wrapped, initialMessages)

      // Below threshold → restart with original args, no nudge
      expect(callCount).toBe(2)
      expect(receivedPrompt).toEqual(initialMessages)

      // The below-threshold log must read threshold from evidenceThresholds.doomLoop (2),
      // NOT the stepLoop fallback (99) — proving the thresholdKey mapping.
      expect(infoSpy).toHaveBeenCalledWith(
        "loop detected but evidence below threshold — continuing stream",
        expect.objectContaining({
          type: "doom_loop",
          threshold: 2,
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  test("L5 nudge applied log includes loopType: doom_loop and toolName", async () => {
    const logger = getUnstuckLogger()
    const infoSpy = spyOn(logger, "info")
    try {
      const { model } = createDoomModel(doomLoopChunks())
      const detector = new LoopDetectorImpl()
      const wrapped = wrapWithLoopDetection(model, detector, doomConfig)

      await collectStream(wrapped, [{ role: "user", content: "Hello" }])

      expect(infoSpy).toHaveBeenCalledWith(
        "nudge applied",
        expect.objectContaining({
          loopType: "doom_loop",
          toolName: "bash",
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  test("L6 max nudges reached log includes type: doom_loop", async () => {
    const logger = getUnstuckLogger()
    const warnSpy = spyOn(logger, "warn")
    try {
      let callCount = 0
      const loopingModel: LanguageModelV3 = {
        modelId: "test-model",
        provider: "test",
        specificationVersion: "v3",
        supportedUrls: {},
        async doGenerate() {
          throw new Error("not implemented")
        },
        async doStream(): Promise<LanguageModelV3StreamResult> {
          callCount++
          return { stream: createMockStream(doomLoopChunks()) }
        },
      }

      const detector = new LoopDetectorImpl()
      const config: UnstuckConfig = { ...doomConfig, maxNudges: 1 }
      const wrapped = wrapWithLoopDetection(loopingModel, detector, config)

      await expectThrowsLoopDetected(() => collectStream(wrapped, [{ role: "user", content: "Hello" }]))

      expect(warnSpy).toHaveBeenCalledWith(
        "max nudges reached, aborting",
        expect.objectContaining({
          type: "doom_loop",
        }),
      )
      expect(callCount).toBeGreaterThan(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("L7 doom_loop config debug log present on wrapWithLoopDetection init", async () => {
    const logger = getUnstuckLogger()
    const debugSpy = spyOn(logger, "debug")
    try {
      const model = createMockModel([])
      const detector = new LoopDetectorImpl()
      wrapWithLoopDetection(model, detector, defaultConfig)

      expect(debugSpy).toHaveBeenCalledWith(
        "doom_loop config",
        expect.objectContaining({
          enableDoomLoopDetection: true,
          doomLoopThreshold: 3,
          evidenceDoomLoop: 1,
        }),
      )
    } finally {
      debugSpy.mockRestore()
    }
  })
})

describe("defaultConfig", () => {
  test("maxNudges defaults to 10", () => {
    expect(defaultConfig.maxNudges).toBe(10)
  })
})

import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3StreamPart, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import { LoopDetectorImpl } from "./loop-detector"
import { wrapWithLoopDetection } from "./wrapper"
import { defaultConfig, type UnstuckConfig } from "./config"
import { LoopDetectedError } from "./error"

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

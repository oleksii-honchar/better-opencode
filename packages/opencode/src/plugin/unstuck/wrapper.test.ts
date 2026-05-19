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
  test("prunes assistant messages and injects nudge on loop", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
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
        const chunks = callCount === 1 ? loopingChunks : recoveryChunks
        return { stream: createMockStream(chunks) }
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

    // Should have looping chunks + recovery chunks (looping chunks are yielded before loop is detected)
    // The loop is detected on the 3rd finish, so that chunk is NOT yielded
    expect(result.length).toBe(loopingChunks.length + recoveryChunks.length - 1)

    // Should have called doStream twice
    expect(callCount).toBe(2)

    // Should have pruned 2 assistant messages and injected nudge
    expect(receivedPrompt.length).toBe(initialMessages.length - 2 + 1) // -2 pruned + 1 nudge
    expect(receivedPrompt[receivedPrompt.length - 1].role).toBe("user")
    expect(String(receivedPrompt[receivedPrompt.length - 1].content)).toContain("stuck in a loop")
  })
})

describe("wrapWithLoopDetection — max nudges exceeded", () => {
  test("falls back to abort after max nudges", async () => {
    let callCount = 0

    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
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

    // Should have tried nudge once, then aborted
    expect(callCount).toBe(2)
  })
})

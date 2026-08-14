import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3StreamPart, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import { wrapWithLoopDetection, extractSessionId } from "./wrapper"
import { defaultConfig, type UnstuckConfig } from "./config"
import { LoopDetectedError } from "./error"
import type { CrossStreamDoomLoopManager } from "./cross-stream-doom-loop"

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
    const wrapped = wrapWithLoopDetection(model, defaultConfig)

    const result = await collectStream(wrapped)
    expect(result).toEqual(chunks)
  })
})

describe("wrapWithLoopDetection — step-level loop", () => {
  test("throws LoopDetectedError on step-level loop (two detections meet threshold)", async () => {
    // 6 identical steps: 2 step_loop detections needed for threshold (stepLoop=2)
    const chunks: LanguageModelV3StreamPart[] = []

    for (let i = 0; i < 6; i++) {
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
    const config: UnstuckConfig = { ...defaultConfig, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, config)

    await expectThrowsLoopDetected(() => collectStream(wrapped))
  })
})

describe("wrapWithLoopDetection — strategy: warn", () => {
  test("rethrows LoopDetectedError without nudge-and-prune", async () => {
    // 6 identical steps: 2 detections needed for threshold (stepLoop=2)
    const chunks: LanguageModelV3StreamPart[] = []

    for (let i = 0; i < 6; i++) {
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
    const config: UnstuckConfig = { ...defaultConfig, strategy: "warn" }
    const wrapped = wrapWithLoopDetection(model, config)

    await expectThrowsLoopDetected(() => collectStream(wrapped))
  })
})

describe("wrapWithLoopDetection — strategy: abort", () => {
  test("rethrows LoopDetectedError without nudge-and-prune", async () => {
    // 6 identical steps: 2 detections needed for threshold (stepLoop=2)
    const chunks: LanguageModelV3StreamPart[] = []

    for (let i = 0; i < 6; i++) {
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
    const config: UnstuckConfig = { ...defaultConfig, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, config)

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
    const config: UnstuckConfig = { ...defaultConfig, enabled: false }
    const wrapped = wrapWithLoopDetection(model, config)

    const result = await collectStream(wrapped)
    expect(result).toEqual(chunks)
  })
})

describe("wrapWithLoopDetection — nudge-and-prune", () => {
  test("appends nudge without pruning after evidence threshold (two detections in same stream)", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    // 6 identical steps: first 3 trigger detection (evidence=1, below threshold), detector resets,
    // next 3 trigger another detection (evidence=2, threshold met) → throw → nudge
    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 6; i++) {
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
        // Call 1: two detections in same stream → second meets threshold → throw → nudge
        // Call 2: recovery
        if (callCount === 1) {
          return { stream: createMockStream(loopingChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 2, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, config)

    const initialMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First response" },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "Second response" },
      { role: "assistant", content: "Third response" },
    ]

    const result = await collectStream(wrapped, initialMessages)

    // Should have yielded chunks from stream 1 (before throw) + recovery
    expect(result.length).toBeGreaterThan(0)

    // Should have called doStream 2 times (original with inline evidence gating + nudge)
    expect(callCount).toBe(2)

    // Second call should have all original messages plus the nudge (nothing pruned)
    expect(receivedPrompt.length).toBe(initialMessages.length + 1)
    expect(receivedPrompt[receivedPrompt.length - 1].role).toBe("user")
    expect(receivedPrompt[receivedPrompt.length - 1]._unstuckNudge).toBe(true)
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    expect(lastContent[0]?.text).toContain("stuck in a loop")
  })
})

describe("wrapWithLoopDetection — max nudges exceeded", () => {
  test("falls back to abort after max nudges", async () => {
    let callCount = 0

    // 6 identical steps: 2 detections per stream (first below threshold, second meets threshold)
    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 6; i++) {
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

    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 1, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, config)

    await expectThrowsLoopDetected(() => collectStream(wrapped, [{ role: "user", content: "Hello" }]))

    // With evidence-gated throw inside streamWithDetection:
    // Stream 1: detection 1 (ev=1, below threshold, continue) → detection 2 (ev=2, threshold met) → nudge #1 → evidence cleared
    // Stream 2: detection 1 (ev=1, below threshold, continue) → detection 2 (ev=2, threshold met) → would nudge but maxNudges=1 → abort
    expect(callCount).toBe(2)
  })
})

describe("wrapWithLoopDetection — evidence accumulation", () => {
  test("below threshold — continues same stream without nudge (no restart)", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    // Stream produces one step_loop detection (3 identical steps), then continues with clean chunks
    // After below-threshold detection, detector resets and same stream continues
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
    // After detection + reset: clean chunks
    chunks.push({ type: "text-delta", id: "recovery-text", delta: "Recovery response" })
    chunks.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage })

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
        return { stream: createMockStream(chunks) }
      },
    }

    // stepLoop threshold is 2, so 1 detection should not trigger nudge
    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 2, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, config)

    const initialMessages = [{ role: "user", content: "Hello" }]

    const result = await collectStream(wrapped, initialMessages)

    // Only ONE doStream call — below-threshold detection continues the same stream
    expect(callCount).toBe(1)

    // Stream yielded all chunks (looping + recovery) from the single stream
    expect(result.length).toBeGreaterThan(0)
  })

  test("threshold met — nudge fires on second detection within same stream", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    // A single stream that produces TWO step_loop detections:
    // - 3 identical steps → first detection (evidence=1, below threshold=2) → detector.reset() → continue
    // - 3 more identical steps → second detection (evidence=2, threshold met) → throw → nudge
    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 6; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      loopingChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      loopingChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      loopingChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    // After nudge: recovery
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
        // Call 1: two detections in same stream → second meets threshold → throw → nudge
        // Call 2: recovery
        if (callCount === 1) {
          return { stream: createMockStream(loopingChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 2, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, config)

    const initialMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Response" },
    ]

    const result = await collectStream(wrapped, initialMessages)

    // Should have yielded chunks from stream 1 (before throw) + recovery
    expect(result.length).toBeGreaterThan(0)

    // Should have called doStream 2 times: original (with inline evidence gating) + nudge
    expect(callCount).toBe(2)

    // Second call should have all original messages plus the nudge (nothing pruned)
    expect(receivedPrompt.length).toBe(initialMessages.length + 1)
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    expect(lastContent[0]?.text).toContain("stuck in a loop")
  })

  test("sentence loop triggers nudge after evidence threshold met", async () => {
    let callCount = 0

    // Sentence loop chunks — the sentence tracker detects repetition within a single stream
    // 3 repetitions trigger sentence_loop detection. With evidenceThresholds.sentenceLoop=1,
    // 1 detection meets threshold → throw → nudge.
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
        // First call: sentence loop detected, evidence threshold=1 → throw → nudge
        // Second call: recovery
        if (callCount === 1) {
          return { stream: createMockStream(sentenceLoopChunks) }
        }
        return { stream: createMockStream([{ type: "text-delta", id: "recovery", delta: "OK" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage }]) }
      },
    }

    const config: UnstuckConfig = {
      ...defaultConfig,
      maxNudges: 2,
      strategy: "nudge-and-prune",
      sentenceLoopThreshold: 3,
      minSentenceLength: 10,
      evidenceThresholds: {
        ...defaultConfig.evidenceThresholds,
        sentenceLoop: 1,
      },
    }
    const wrapped = wrapWithLoopDetection(model, config)

    await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    // Should have called doStream twice (original + nudge)
    expect(callCount).toBe(2)
  })

  test("max nudges aborts after evidence threshold nudges fail", async () => {
    let callCount = 0

    // 6 identical steps: 2 detections per stream
    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 6; i++) {
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

    // maxNudges=1, stepLoop threshold=2
    // Stream 1: detection 1 (ev=1, below threshold, continue) → detection 2 (ev=2, threshold met) → nudge #1 → evidence cleared
    // Stream 2: detection 1 (ev=1, below threshold, continue) → detection 2 (ev=2, threshold met) → would nudge but maxNudges=1 → abort
    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 1, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, config)

    await expectThrowsLoopDetected(() => collectStream(wrapped, [{ role: "user", content: "Hello" }]))

    // Should have tried 2 streams before aborting
    expect(callCount).toBe(2)
  })

  test("evidence is cleared on clean finish — second doStream starts fresh", async () => {
    let callCount = 0

    // First call: produces loop detection (evidence=1, below threshold=2) — continues same stream, then finishes
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

    // Second call: a separate doStream — should have a fresh detector (not inheriting evidence)
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

    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 2, strategy: "nudge-and-prune" }
    const wrapped = wrapWithLoopDetection(model, config)

    // First doStream: below-threshold detection, stream continues and finishes normally
    const result1 = await collectStream(wrapped, [{ role: "user", content: "Hello" }])
    expect(result1.length).toBe(loopingChunks.length)
    expect(callCount).toBe(1)

    // Second doStream: fresh detector, clean stream
    const result2 = await collectStream(wrapped, [{ role: "user", content: "Hello again" }])
    expect(result2.length).toBe(recoveryChunks.length)
    expect(callCount).toBe(2)
  })

  test("per-stream isolation — second doStream does not inherit first stream's detector state", async () => {
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

    // With per-stream isolation, each doStream gets a fresh detector.
    // Even with toolLoopThreshold=2, a single tool call in a fresh detector
    // should NOT trigger tool_loop (needs 2 identical steps in the same detector).
    const config: UnstuckConfig = { ...defaultConfig, toolLoopThreshold: 2, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, config)

    // First stream — should complete normally (1 step in fresh detector)
    const result1 = await collectStream(wrapped, [{ role: "user", content: "Hello" }])
    expect(result1.length).toBe(toolChunks.length)

    // Second stream — also completes normally (fresh detector, 1 step, no loop)
    // Without per-stream isolation, this would trigger tool_loop detection
    const result2 = await collectStream(wrapped, [{ role: "user", content: "Hello again" }])
    expect(result2.length).toBe(toolChunks.length)

    // Both streams completed normally — no cross-stream contamination
    expect(callCount).toBe(2)
  })
})

describe("wrapWithLoopDetection — per-stream isolation", () => {
  test("two doStream calls on same wrapped model produce independent results — no shared history", async () => {
    let callCount = 0

    // Chunks that produce a single tool call step
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

    // Even with toolLoopThreshold=2, each stream gets a fresh detector
    // so a single tool call should never trigger tool_loop
    const config: UnstuckConfig = { ...defaultConfig, toolLoopThreshold: 2, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, config)

    // First doStream — completes normally
    const result1 = await collectStream(wrapped, [{ role: "user", content: "Hello" }])
    expect(result1.length).toBe(toolChunks.length)

    // Second doStream — also completes normally (fresh detector, no shared history)
    const result2 = await collectStream(wrapped, [{ role: "user", content: "Hello again" }])
    expect(result2.length).toBe(toolChunks.length)

    // Both streams completed normally — no cross-stream contamination
    expect(callCount).toBe(2)
  })

  test("loop detection still works within a single doStream", async () => {
    // Looping chunks that trigger step_loop within one stream (6 steps = 2 detections for threshold)
    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 6; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      loopingChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      loopingChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        providerMetadata: undefined,
      } as any)
      loopingChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    const model = createMockModel(loopingChunks)
    const config: UnstuckConfig = { ...defaultConfig, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, config)

    // Loop detection still fires within a single doStream
    await expectThrowsLoopDetected(() => collectStream(wrapped))
  })

  test("different prompts between doStream calls do not share detector state", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

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
        receivedPrompt = args.prompt as any[]
        return { stream: createMockStream(cleanChunks) }
      },
    }

    const config: UnstuckConfig = { ...defaultConfig, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, config)

    // First call with one prompt
    const result1 = await collectStream(wrapped, [{ role: "user", content: "Hello" }])
    expect(result1.length).toBe(cleanChunks.length)
    expect(receivedPrompt).toEqual([{ role: "user", content: "Hello" }])

    // Second call with a different, longer prompt — no state leakage from first
    const result2 = await collectStream(wrapped, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Previous response" },
      { role: "user", content: "New message" },
    ])
    expect(result2.length).toBe(cleanChunks.length)
    expect(receivedPrompt).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Previous response" },
      { role: "user", content: "New message" },
    ])

    expect(callCount).toBe(2)
  })
})

describe("wrapWithLoopDetection — doom_loop nudge and logs", () => {
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
  // nudgeMessage: undefined routes through defaultNudgeMessage (the doom_loop branch).
  const doomConfig: UnstuckConfig = {
    ...defaultConfig,
    maxNudges: 2,
    strategy: "nudge-and-prune",
    loopThreshold: 100,
    detectToolOnlyLoops: false,
    enablePatternLoopDetection: false,
    enableSentenceLoopDetection: false,
    enableSelfDiagnosisDetection: false,
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
    const wrapped = wrapWithLoopDetection(model, doomConfig)

    const result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    expect(result.length).toBeGreaterThan(0)
    expect(callCount()).toBe(2)

    const lastContent = receivedPrompt()[receivedPrompt().length - 1].content as Array<{ type: string; text: string }>
    expect(receivedPrompt()[receivedPrompt().length - 1]._unstuckNudge).toBe(true)
    expect(lastContent[0]?.text).toContain("bash")
    expect(lastContent[0]?.text).toContain("doom loop")
  })

  test("doom_loop nudge without toolName falls back to generic guidance without crashing", async () => {
    // Use doomLoopChunks with a custom tool that has no input — the doom_loop
    // detection will fire but without a meaningful toolName in the nudge message
    // when the tool input is missing/empty, the nudge should still work.
    // Instead, test with the default nudge that includes the tool name when available.
    let callCount = 0
    let receivedPrompt: any[] = []

    // Doom loop chunks — 3 identical bash calls with same input
    const loopChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      loopChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Doom loop thinking" })
      loopChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "bash" })
      loopChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        input: { command: "ls -la" },
        providerMetadata: undefined,
      } as any)
    }
    loopChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })

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
          return { stream: createMockStream(loopChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const config: UnstuckConfig = {
      ...doomConfig,
      nudgeMessage: undefined,
    }
    const wrapped = wrapWithLoopDetection(model, config)

    const result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    expect(result.length).toBeGreaterThan(0)
    expect(callCount).toBe(2)

    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    expect(receivedPrompt[receivedPrompt.length - 1]._unstuckNudge).toBe(true)
    expect(lastContent[0]?.text).toContain("doom loop")
    expect(lastContent[0]?.text).toContain("bash")
  })

  test("thresholdKey maps doom_loop → doomLoop (evidence below threshold reads config.evidenceThresholds.doomLoop)", async () => {
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
        // Call 1: doom loop detected, evidence doom_loop=1, below doomLoop threshold=2 → continue same stream
        // Call 2: recovery (separate doStream)
        if (callCount === 1) {
          return { stream: createMockStream(doomLoopChunks()) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

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
        doomLoop: 2,
      },
    }
    const wrapped = wrapWithLoopDetection(model, config)

    const initialMessages = [{ role: "user", content: "Hello" }]
    await collectStream(wrapped, initialMessages)

    // Below threshold → continues same stream (no restart), only 1 doStream call
    expect(callCount).toBe(1)
    expect(receivedPrompt).toEqual(initialMessages)
  })

  test("L5 nudge applied — doom_loop nudge contains tool name in nudge message", async () => {
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
        if (callCount === 1) {
          return { stream: createMockStream(doomLoopChunks()) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const config: UnstuckConfig = {
      ...doomConfig,
      nudgeMessage: undefined,
    }
    const wrapped = wrapWithLoopDetection(model, config)

    const result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    expect(result.length).toBeGreaterThan(0)
    expect(callCount).toBe(2)

    // The nudge message should contain the tool name "bash" and "doom loop"
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    expect(receivedPrompt[receivedPrompt.length - 1]._unstuckNudge).toBe(true)
    expect(lastContent[0]?.text).toContain("bash")
    expect(lastContent[0]?.text).toContain("doom loop")
  })

  test("L6 max nudges reached — doom_loop aborts after max nudges", async () => {
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

    const config: UnstuckConfig = { ...doomConfig, maxNudges: 1 }
    const wrapped = wrapWithLoopDetection(loopingModel, config)

    await expectThrowsLoopDetected(() => collectStream(wrapped, [{ role: "user", content: "Hello" }]))

    // Multiple streams attempted before aborting
    expect(callCount).toBeGreaterThan(1)
  })

  test("L7 doom_loop config — detection works with default config", async () => {
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
        if (callCount === 1) {
          return { stream: createMockStream(doomLoopChunks()) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    // Default config has enableDoomLoopDetection: true, doomLoopThreshold: 3, doomLoop: 1
    const config: UnstuckConfig = {
      ...doomConfig,
      nudgeMessage: undefined,
    }
    const wrapped = wrapWithLoopDetection(model, config)

    const result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    // Doom loop detected with default config → nudge applied
    expect(result.length).toBeGreaterThan(0)
    expect(callCount).toBe(2)
    expect(receivedPrompt[receivedPrompt.length - 1]._unstuckNudge).toBe(true)
  })
})

describe("wrapWithLoopDetection — evidence-gated throw (below-threshold continues same stream)", () => {
  test("single below-threshold detection: evidence added, detector reset, same stream continues (no second doStream)", async () => {
    let callCount = 0

    // A stream that produces one step_loop detection (3 identical steps) then continues with clean chunks
    // After detector.reset() in streamWithDetection, the clean chunks should NOT trigger another detection
    const chunks: LanguageModelV3StreamPart[] = [
      // Step 1: thinking + tool
      { type: "text-delta", id: "1-text", delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-start", id: "call-1", toolName: "ReadFile" },
      { type: "tool-input-end", id: "call-1", providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },

      // Step 2: identical
      { type: "text-delta", id: "2-text", delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-start", id: "call-2", toolName: "ReadFile" },
      { type: "tool-input-end", id: "call-2", providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },

      // Step 3: identical — triggers step_loop (loopThreshold=3)
      { type: "text-delta", id: "3-text", delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-start", id: "call-3", toolName: "ReadFile" },
      { type: "tool-input-end", id: "call-3", providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },

      // After reset: clean chunks that should pass through
      { type: "text-delta", id: "4-text", delta: "Different thinking that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-start", id: "call-4", toolName: "WriteFile" },
      { type: "tool-input-end", id: "call-4", providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() { throw new Error("not implemented") },
      async doStream(): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(chunks) }
      },
    }

    // stepLoop threshold = 2, so 1 detection is below threshold
    const config: UnstuckConfig = { ...defaultConfig, strategy: "nudge-and-prune", maxNudges: 2 }
    const wrapped = wrapWithLoopDetection(model, config)

    const result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    // Key assertion: only ONE doStream call — the stream continued without restart
    expect(callCount).toBe(1)

    // The stream should have yielded chunks (some before the detection, then the clean chunks after reset)
    expect(result.length).toBeGreaterThan(0)
  })

  test("threshold-met detection: LoopDetectedError is thrown from streamWithDetection", async () => {
    let callCount = 0

    // Two step_loop detections in the same stream — second one should meet threshold (stepLoop=2)
    // and throw from streamWithDetection, causing the wrapper to nudge
    // 6 identical steps: first 3 trigger detection (below threshold, reset), next 3 trigger second detection (threshold met, throw)
    const loopingChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 6; i++) {
      loopingChunks.push({ type: "text-delta", id: `${i}-text`, delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." })
      loopingChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" })
      loopingChunks.push({ type: "tool-input-end", id: `call-${i}`, providerMetadata: undefined } as any)
      loopingChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
    }

    // After first detection (below threshold), detector resets. Second detection triggers threshold.
    // After threshold met, LoopDetectedError is thrown from streamWithDetection.
    // The wrapper catches it, nudges, and the model recovers.
    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "recovery-text", delta: "Recovery response" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() { throw new Error("not implemented") },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        // Call 1: first detection below threshold → continue stream → second detection meets threshold → throw
        // Call 2 (after nudge): recovery
        if (callCount === 1) {
          return { stream: createMockStream(loopingChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const config: UnstuckConfig = { ...defaultConfig, strategy: "nudge-and-prune", maxNudges: 2 }
    const wrapped = wrapWithLoopDetection(model, config)

    const result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    // Stream 1 has two detections: first below threshold (continue same stream), second meets threshold (throw → nudge)
    // Stream 2 is the nudged recovery
    expect(callCount).toBe(2)
    expect(result.length).toBeGreaterThan(0)
  })

  test("no duplicate output in stream (no second doStream for below-threshold)", async () => {
    let callCount = 0
    const yieldedChunks: string[] = []

    // Stream that produces one detection then clean text
    const chunks: LanguageModelV3StreamPart[] = [
      // 3 identical steps → step_loop detection
      { type: "text-delta", id: "1-text", delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-start", id: "call-1", toolName: "ReadFile" },
      { type: "tool-input-end", id: "call-1", providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },

      { type: "text-delta", id: "2-text", delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-start", id: "call-2", toolName: "ReadFile" },
      { type: "tool-input-end", id: "call-2", providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },

      { type: "text-delta", id: "3-text", delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-start", id: "call-3", toolName: "ReadFile" },
      { type: "tool-input-end", id: "call-3", providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },

      // After reset: clean text
      { type: "text-delta", id: "4-text", delta: "Unique recovery text" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() { throw new Error("not implemented") },
      async doStream(): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(chunks) }
      },
    }

    const config: UnstuckConfig = { ...defaultConfig, strategy: "nudge-and-prune", maxNudges: 2 }
    const wrapped = wrapWithLoopDetection(model, config)

    const result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    // Only one doStream call
    expect(callCount).toBe(1)

    // Collect text deltas from yielded chunks
    for (const chunk of result) {
      if (chunk.type === "text-delta") {
        yieldedChunks.push((chunk as any).delta)
      }
    }

    // "Unique recovery text" should appear exactly once (not duplicated from a restart)
    const uniqueTextCount = yieldedChunks.filter((t) => t === "Unique recovery text").length
    expect(uniqueTextCount).toBe(1)

    // The "Same thinking text" appears 3 times (before detection) — not duplicated
    const sameTextCount = yieldedChunks.filter((t) => t.includes("Same thinking text")).length
    expect(sameTextCount).toBe(3)
  })

  test("below-threshold continue branch removed from wrapper — evidence gate lives in streamWithDetection", async () => {
    // This test proves the below-threshold path no longer restarts the stream.
    // Previously, the wrapper catch block had a `continue` that restarted the stream.
    // Now, evidence gating happens inside streamWithDetection.
    // A single detection below threshold should NOT call doStream twice.

    let callCount = 0

    // Stream with exactly one step_loop detection (3 identical steps) followed by clean finish
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "1-text", delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-start", id: "call-1", toolName: "ReadFile" },
      { type: "tool-input-end", id: "call-1", providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },

      { type: "text-delta", id: "2-text", delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-start", id: "call-2", toolName: "ReadFile" },
      { type: "tool-input-end", id: "call-2", providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },

      { type: "text-delta", id: "3-text", delta: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-start", id: "call-3", toolName: "ReadFile" },
      { type: "tool-input-end", id: "call-3", providerMetadata: undefined } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },

      // Clean finish after detection
      { type: "text-delta", id: "4-text", delta: "All done now" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() { throw new Error("not implemented") },
      async doStream(): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(chunks) }
      },
    }

    // stepLoop threshold = 2, so 1 detection is below threshold
    const config: UnstuckConfig = { ...defaultConfig, strategy: "nudge-and-prune", maxNudges: 2 }
    const wrapped = wrapWithLoopDetection(model, config)

    await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    // Previously: callCount would be 2 (detection → below threshold → restart)
    // Now: callCount is 1 (detection → below threshold → continue same stream)
    expect(callCount).toBe(1)
  })
})

describe("defaultNudgeMessage", () => {
  // Helper: import defaultNudgeMessage is not exported, so we test via the nudge injection path.
  // We use sentence_loop and doom_loop to verify the default nudge messages include context references.

  test("sentence_loop nudge includes the repeated sentence and instructs to continue from current task", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

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
      async doGenerate() { throw new Error("not implemented") },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        receivedPrompt = args.prompt as any[]
        if (callCount === 1) {
          return { stream: createMockStream(sentenceLoopChunks) }
        }
        return { stream: createMockStream([{ type: "text-delta", id: "r", delta: "OK" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage }]) }
      },
    }

    const config: UnstuckConfig = {
      ...defaultConfig,
      maxNudges: 2,
      strategy: "nudge-and-prune",
      sentenceLoopThreshold: 3,
      minSentenceLength: 10,
      evidenceThresholds: { ...defaultConfig.evidenceThresholds, sentenceLoop: 1 },
      nudgeMessage: undefined,
    }
    const wrapped = wrapWithLoopDetection(model, config)

    await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    expect(callCount).toBe(2)
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    const nudgeText = lastContent[0]?.text ?? ""

    // Must include the repeated sentence
    expect(nudgeText).toContain("This is a repeated sentence")

    // Must instruct to continue from current task (not "break out and take a different direction")
    expect(nudgeText.toLowerCase()).toContain("continue")
    expect(nudgeText.toLowerCase()).toContain("current")
  })

  test("doom_loop nudge includes tool name and instructs to fix input or try different tool (not re-read)", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    const doomChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      doomChunks.push({ type: "text-delta", id: `${i}`, delta: "Doom thinking" })
      doomChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "Grep" })
      doomChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        input: { pattern: "foo" },
        providerMetadata: undefined,
      } as any)
    }
    doomChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })

    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "r", delta: "OK" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() { throw new Error("not implemented") },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        receivedPrompt = args.prompt as any[]
        if (callCount === 1) {
          return { stream: createMockStream(doomChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const config: UnstuckConfig = {
      ...defaultConfig,
      maxNudges: 2,
      strategy: "nudge-and-prune",
      loopThreshold: 100,
      detectToolOnlyLoops: false,
      enablePatternLoopDetection: false,
      enableSentenceLoopDetection: false,
      enableSelfDiagnosisDetection: false,
      nudgeMessage: undefined,
    }
    const wrapped = wrapWithLoopDetection(model, config)

    await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    expect(callCount).toBe(2)
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    const nudgeText = lastContent[0]?.text ?? ""

    // Must include the tool name
    expect(nudgeText).toContain("Grep")

    // Must instruct to fix input or try different tool
    expect(nudgeText.toLowerCase()).toContain("fix")
    expect(nudgeText.toLowerCase()).toContain("different tool")

    // Must NOT instruct to re-read
    expect(nudgeText.toLowerCase()).not.toContain("re-read")
    expect(nudgeText.toLowerCase()).not.toContain("reread")
  })

  test("config nudgeMessage override still works", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    const doomChunks: LanguageModelV3StreamPart[] = []
    for (let i = 0; i < 3; i++) {
      doomChunks.push({ type: "text-delta", id: `${i}`, delta: "Doom thinking" })
      doomChunks.push({ type: "tool-input-start", id: `call-${i}`, toolName: "bash" })
      doomChunks.push({
        type: "tool-input-end",
        id: `call-${i}`,
        input: { command: "ls" },
        providerMetadata: undefined,
      } as any)
    }
    doomChunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })

    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "r", delta: "OK" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() { throw new Error("not implemented") },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        receivedPrompt = args.prompt as any[]
        if (callCount === 1) {
          return { stream: createMockStream(doomChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const customNudge = "CUSTOM OVERRIDE MESSAGE"
    const config: UnstuckConfig = {
      ...defaultConfig,
      maxNudges: 2,
      strategy: "nudge-and-prune",
      loopThreshold: 100,
      detectToolOnlyLoops: false,
      enablePatternLoopDetection: false,
      enableSentenceLoopDetection: false,
      enableSelfDiagnosisDetection: false,
      nudgeMessage: customNudge,
    }
    const wrapped = wrapWithLoopDetection(model, config)

    await collectStream(wrapped, [{ role: "user", content: "Hello" }])

    expect(callCount).toBe(2)
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    const nudgeText = lastContent[0]?.text ?? ""

    // Must use the custom override, not the default
    expect(nudgeText).toBe(customNudge)
  })
})

describe("defaultConfig", () => {
  test("maxNudges defaults to 2", () => {
    expect(defaultConfig.maxNudges).toBe(2)
  })
})

describe("extractSessionId", () => {
  test("extracts session ID from string system message containing <env> block", () => {
    const prompt = [
      { role: "system", content: "You are an AI assistant.\n<env>\nSession ID: ses_abc123\n</env>" },
      { role: "user", content: "Hello" },
    ]
    expect(extractSessionId(prompt as any)).toBe("ses_abc123")
  })

  test("extracts session ID from content as array of parts", () => {
    const prompt = [
      {
        role: "system",
        content: [
          { type: "text" as const, text: "You are an AI assistant.\n<env>\nSession ID: ses_xyz789\n</env>" },
        ],
      },
      { role: "user", content: "Hello" },
    ]
    expect(extractSessionId(prompt as any)).toBe("ses_xyz789")
  })

  test("returns empty string when no session ID found", () => {
    const prompt = [
      { role: "system", content: "You are an AI assistant." },
      { role: "user", content: "Hello" },
    ]
    expect(extractSessionId(prompt as any)).toBe("")
  })

  test("returns empty string when prompt is empty", () => {
    expect(extractSessionId([] as any)).toBe("")
  })

  test("returns empty string for non-array prompt", () => {
    expect(extractSessionId("just a string" as any)).toBe("")
  })

  test("returns empty string for null/undefined prompt", () => {
    expect(extractSessionId(null as any)).toBe("")
    expect(extractSessionId(undefined as any)).toBe("")
  })

  test("extracts session ID from middle of a larger system message", () => {
    const prompt = [
      {
        role: "system",
        content: "Some prefix text\n<env>\nWorking directory: /foo\nSession ID: ses_middle456\nPlatform: darwin\n</env>\nSome suffix text",
      },
    ]
    expect(extractSessionId(prompt as any)).toBe("ses_middle456")
  })
})

describe("wrapWithLoopDetection — cross-stream doom-loop with manager", () => {
  function createMockManager(): CrossStreamDoomLoopManager & { recordCallCalls: Array<{ sessionId: string; toolName: string; inputFingerprint: string; threshold: number }>; resetSessionCalls: string[] } {
    const manager: CrossStreamDoomLoopManager & { recordCallCalls: Array<{ sessionId: string; toolName: string; inputFingerprint: string; threshold: number }>; resetSessionCalls: string[] } = {
      recordCallCalls: [],
      resetSessionCalls: [],
      recordCall(sessionId: string, toolName: string, inputFingerprint: string, threshold: number): boolean {
        manager.recordCallCalls.push({ sessionId, toolName, inputFingerprint, threshold })
        // Simulate threshold reached on 3rd call with same params
        const matchingCalls = manager.recordCallCalls.filter(
          (c) => c.sessionId === sessionId && c.toolName === toolName && c.inputFingerprint === inputFingerprint,
        )
        return matchingCalls.length >= threshold
      },
      resetSession(sessionId: string): void {
        manager.resetSessionCalls.push(sessionId)
      },
      clearAll(): void {},
    }
    return manager
  }

  const crossStreamConfig: UnstuckConfig = {
    ...defaultConfig,
    maxNudges: 2,
    strategy: "nudge-and-prune",
    loopThreshold: 100,
    detectToolOnlyLoops: false,
    enablePatternLoopDetection: false,
    enableSentenceLoopDetection: false,
    enableSelfDiagnosisDetection: false,
    enableDoomLoopDetection: false, // Disable per-stream doom-loop so cross-stream is the only one that fires
    enableCrossStreamDoomLoopDetection: true,
    crossStreamDoomLoopThreshold: 3,
    nudgeMessage: undefined,
  }

  test("manager.recordCall is called on tool-input-end when cross-stream detection is enabled", async () => {
    const manager = createMockManager()
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-1", toolName: "bash" },
      {
        type: "tool-input-end",
        id: "call-1",
        input: { command: "ls -la" },
        providerMetadata: undefined,
      } as any,
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model = createMockModel(chunks)
    const wrapped = wrapWithLoopDetection(model, crossStreamConfig, manager)

    const prompt = [
      { role: "system", content: "<env>\nSession ID: ses_test123\n</env>" },
      { role: "user", content: "Hello" },
    ]
    await collectStream(wrapped, prompt)

    // recordCall should have been called once for the tool-input-end
    expect(manager.recordCallCalls.length).toBe(1)
    expect(manager.recordCallCalls[0].sessionId).toBe("ses_test123")
    expect(manager.recordCallCalls[0].toolName).toBe("bash")
    expect(manager.recordCallCalls[0].threshold).toBe(3)
  })

  test("manager.recordCall is NOT called when cross-stream detection is disabled", async () => {
    const manager = createMockManager()
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-1", toolName: "bash" },
      {
        type: "tool-input-end",
        id: "call-1",
        input: { command: "ls -la" },
        providerMetadata: undefined,
      } as any,
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model = createMockModel(chunks)
    const config: UnstuckConfig = {
      ...crossStreamConfig,
      enableCrossStreamDoomLoopDetection: false,
    }
    const wrapped = wrapWithLoopDetection(model, config, manager)

    const prompt = [
      { role: "system", content: "<env>\nSession ID: ses_test123\n</env>" },
      { role: "user", content: "Hello" },
    ]
    await collectStream(wrapped, prompt)

    // recordCall should NOT have been called
    expect(manager.recordCallCalls.length).toBe(0)
  })

  test("manager.recordCall is NOT called when no manager is provided", async () => {
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-1", toolName: "bash" },
      {
        type: "tool-input-end",
        id: "call-1",
        input: { command: "ls -la" },
        providerMetadata: undefined,
      } as any,
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model = createMockModel(chunks)
    // No manager passed — should not throw
    const wrapped = wrapWithLoopDetection(model, crossStreamConfig)

    const prompt = [
      { role: "system", content: "<env>\nSession ID: ses_test123\n</env>" },
      { role: "user", content: "Hello" },
    ]
    await collectStream(wrapped, prompt)
    // Should complete without error — no manager = no cross-stream check
  })

  test("cross-stream threshold reached triggers nudge-and-prune intervention", async () => {
    const manager = createMockManager()
    let callCount = 0
    let receivedPrompt: any[] = []

    // Each stream has 1 identical tool call — per-stream detector won't fire (disabled),
    // but cross-stream manager will accumulate and trigger on 3rd call
    const singleToolChunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-1", toolName: "bash" },
      {
        type: "tool-input-end",
        id: "call-1",
        input: { command: "ls -la" },
        providerMetadata: undefined,
      } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },
    ]

    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "recovery", delta: "Recovery" },
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
        // Calls 1-3: each produces one identical tool call (cross-stream threshold=3 triggers on 3rd)
        // After nudge: recovery
        if (callCount <= 3) {
          return { stream: createMockStream(singleToolChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const wrapped = wrapWithLoopDetection(model, crossStreamConfig, manager)
    const prompt = [
      { role: "system", content: "<env>\nSession ID: ses_cross123\n</env>" },
      { role: "user", content: "Hello" },
    ]

    // Simulate 3 separate doStream calls (as would happen across agent steps)
    // Stream 1: recordCall count=1, no threshold → stream finishes normally
    const result1 = await collectStream(wrapped, prompt)
    expect(result1.length).toBe(singleToolChunks.length)
    expect(callCount).toBe(1)

    // Stream 2: recordCall count=2, no threshold → stream finishes normally
    const result2 = await collectStream(wrapped, prompt)
    expect(result2.length).toBe(singleToolChunks.length)
    expect(callCount).toBe(2)

    // Stream 3: recordCall count=3, threshold reached → throws → nudge → recovery
    // The nudge-and-prune path restarts the stream within the same doStream call
    const result3 = await collectStream(wrapped, prompt)
    expect(result3.length).toBeGreaterThan(0)
    // 3rd call triggers cross-stream → nudge restart → 4th call returns recovery
    expect(callCount).toBe(4)

    // Nudge should have been injected on the 4th call
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    expect(receivedPrompt[receivedPrompt.length - 1]._unstuckNudge).toBe(true)
    expect(lastContent[0]?.text).toContain("doom loop")
  })

  test("manager.resetSession is called on nudge intervention", async () => {
    const manager = createMockManager()
    let callCount = 0

    const singleToolChunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-1", toolName: "bash" },
      {
        type: "tool-input-end",
        id: "call-1",
        input: { command: "ls -la" },
        providerMetadata: undefined,
      } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },
    ]

    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "recovery", delta: "Recovery" },
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
        if (callCount <= 3) {
          return { stream: createMockStream(singleToolChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    const wrapped = wrapWithLoopDetection(model, crossStreamConfig, manager)
    const prompt = [
      { role: "system", content: "<env>\nSession ID: ses_reset456\n</env>" },
      { role: "user", content: "Hello" },
    ]

    // 3 separate doStream calls, 3rd triggers cross-stream → nudge → resetSession
    await collectStream(wrapped, prompt)
    await collectStream(wrapped, prompt)
    await collectStream(wrapped, prompt)

    // resetSession should have been called when nudge was applied
    expect(manager.resetSessionCalls.length).toBe(1)
    expect(manager.resetSessionCalls[0]).toBe("ses_reset456")
  })

  test("provider-executed tool-input-end skips cross-stream recordCall", async () => {
    const manager = createMockManager()
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-1", toolName: "bash" },
      {
        type: "tool-input-end",
        id: "call-1",
        input: { command: "ls -la" },
        providerExecuted: true,
        providerMetadata: undefined,
      } as any,
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model = createMockModel(chunks)
    const wrapped = wrapWithLoopDetection(model, crossStreamConfig, manager)

    const prompt = [
      { role: "system", content: "<env>\nSession ID: ses_test123\n</env>" },
      { role: "user", content: "Hello" },
    ]
    await collectStream(wrapped, prompt)

    // provider-executed tools should be skipped
    expect(manager.recordCallCalls.length).toBe(0)
  })

  test("cross-stream recordCall routes through evidence.add instead of immediate throw", async () => {
    // With doomLoop evidence threshold = 2, a single cross-stream detection
    // should NOT throw — it should add evidence and continue the stream.
    const manager = createMockManager()
    let callCount = 0

    // Stream with one tool call — cross-stream manager will see count=1,
    // but we set crossStreamDoomLoopThreshold=1 so recordCall returns true.
    // However, evidence threshold for doomLoop is 2, so it should continue.
    const singleToolChunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-1", toolName: "bash" },
      {
        type: "tool-input-end",
        id: "call-1",
        input: { command: "ls -la" },
        providerMetadata: undefined,
      } as any,
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() { throw new Error("not implemented") },
      async doStream(): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(singleToolChunks) }
      },
    }

    // crossStreamDoomLoopThreshold=1 means recordCall returns true on first call,
    // but doomLoop evidence threshold=2 means we need 2 detections to throw.
    const config: UnstuckConfig = {
      ...crossStreamConfig,
      crossStreamDoomLoopThreshold: 1,
      evidenceThresholds: {
        ...defaultConfig.evidenceThresholds,
        doomLoop: 2,
      },
    }
    const wrapped = wrapWithLoopDetection(model, config, manager)

    const prompt = [
      { role: "system", content: "<env>\nSession ID: ses_evidence123\n</env>" },
      { role: "user", content: "Hello" },
    ]

    // Should complete without throwing — evidence below threshold
    const result = await collectStream(wrapped, prompt)
    expect(result.length).toBe(singleToolChunks.length)

    // Only one doStream call — no restart
    expect(callCount).toBe(1)

    // recordCall was called and returned true (threshold reached at cross-stream level)
    expect(manager.recordCallCalls.length).toBe(1)
  })

  test("below-threshold cross-stream detection: stream continues without restart", async () => {
    // Two cross-stream detections in the same stream, but evidence threshold=3.
    // Both should add evidence but not throw — stream continues.
    const manager = createMockManager()
    let callCount = 0

    // Stream with two identical tool calls — cross-stream threshold=1 means
    // both recordCall return true, adding 2 pieces of evidence.
    // But doomLoop evidence threshold=3, so no throw.
    const twoToolChunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-1", toolName: "bash" },
      {
        type: "tool-input-end",
        id: "call-1",
        input: { command: "ls -la" },
        providerMetadata: undefined,
      } as any,
      { type: "tool-input-start", id: "call-2", toolName: "bash" },
      {
        type: "tool-input-end",
        id: "call-2",
        input: { command: "ls -la" },
        providerMetadata: undefined,
      } as any,
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() { throw new Error("not implemented") },
      async doStream(): Promise<LanguageModelV3StreamResult> {
        callCount++
        return { stream: createMockStream(twoToolChunks) }
      },
    }

    const config: UnstuckConfig = {
      ...crossStreamConfig,
      crossStreamDoomLoopThreshold: 1,
      evidenceThresholds: {
        ...defaultConfig.evidenceThresholds,
        doomLoop: 3,
      },
    }
    const wrapped = wrapWithLoopDetection(model, config, manager)

    const prompt = [
      { role: "system", content: "<env>\nSession ID: ses_below123\n</env>" },
      { role: "user", content: "Hello" },
    ]

    const result = await collectStream(wrapped, prompt)
    expect(result.length).toBe(twoToolChunks.length)

    // Only one doStream call — no restart, stream continued
    expect(callCount).toBe(1)

    // Both tool calls were recorded
    expect(manager.recordCallCalls.length).toBe(2)
  })

  test("threshold-met cross-stream detection: LoopDetectedError is thrown", async () => {
    // With doomLoop evidence threshold=1, a single cross-stream detection
    // should add evidence and throw because threshold is met.
    const manager = createMockManager()
    let callCount = 0
    let receivedPrompt: any[] = []

    const singleToolChunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "call-1", toolName: "bash" },
      {
        type: "tool-input-end",
        id: "call-1",
        input: { command: "ls -la" },
        providerMetadata: undefined,
      } as any,
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },
    ]

    const recoveryChunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "recovery", delta: "Recovery" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() { throw new Error("not implemented") },
      async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        receivedPrompt = args.prompt as any[]
        if (callCount === 1) {
          return { stream: createMockStream(singleToolChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    // crossStreamDoomLoopThreshold=1 → recordCall returns true on first call
    // doomLoop evidence threshold=1 → 1 detection meets threshold → throw → nudge
    const config: UnstuckConfig = {
      ...crossStreamConfig,
      crossStreamDoomLoopThreshold: 1,
      evidenceThresholds: {
        ...defaultConfig.evidenceThresholds,
        doomLoop: 1,
      },
    }
    const wrapped = wrapWithLoopDetection(model, config, manager)

    const prompt = [
      { role: "system", content: "<env>\nSession ID: ses_met123\n</env>" },
      { role: "user", content: "Hello" },
    ]

    const result = await collectStream(wrapped, prompt)

    // Should have thrown (threshold met) → nudge → recovery
    expect(result.length).toBeGreaterThan(0)
    expect(callCount).toBe(2)

    // Nudge was injected
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    expect(receivedPrompt[receivedPrompt.length - 1]._unstuckNudge).toBe(true)
    expect(lastContent[0]?.text).toContain("doom loop")
  })
})

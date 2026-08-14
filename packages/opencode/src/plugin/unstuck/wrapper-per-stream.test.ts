import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3StreamPart, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import { wrapWithLoopDetection } from "./wrapper"
import { defaultConfig, type UnstuckConfig } from "./config"

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

describe("wrapWithLoopDetection — 2-param API and per-stream isolation", () => {
  test("wrapWithLoopDetection accepts 2 params (model, config) — no detector param", async () => {
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "text-delta", id: "1", delta: "Hello" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
    ]

    const model = createMockModel(chunks)
    // 2-param API: no detector argument
    const wrapped = wrapWithLoopDetection(model, defaultConfig)

    const result = await collectStream(wrapped)
    expect(result).toEqual(chunks)
  })

  test("two doStream calls on same wrapped model are isolated — no shared detector state", async () => {
    let callCount = 0

    // Chunks that produce a tool call step (accumulates history)
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

    // 2-param API: no detector argument
    const config: UnstuckConfig = { ...defaultConfig, toolLoopThreshold: 2, strategy: "abort" }
    const wrapped = wrapWithLoopDetection(model, config)

    // First doStream — should complete normally (1 step in fresh detector)
    const result1 = await collectStream(wrapped, [{ role: "user", content: "Hello" }])
    expect(result1.length).toBe(toolChunks.length)

    // Second doStream — with per-stream isolation, this is a FRESH detector
    // so 1 step should NOT trigger tool_loop (needs 2 identical steps in same detector)
    // Without isolation (old behavior), the second call would share history and trigger detection
    const result2 = await collectStream(wrapped, [{ role: "user", content: "Hello again" }])
    expect(result2.length).toBe(toolChunks.length)

    // Both streams completed normally — no cross-stream contamination
    expect(callCount).toBe(2)
  })

  test("nudge-and-prune within same doStream still works — detector.clear() on nudge path retained", async () => {
    let callCount = 0
    let receivedPrompt: any[] = []

    // 6 identical steps: first 3 trigger detection (below threshold, reset), next 3 trigger second detection (threshold met, throw → nudge)
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
        receivedPrompt = args.prompt as any[]
        // Call 1: two detections in same stream → second meets threshold → throw → nudge
        // Call 2: recovery
        if (callCount === 1) {
          return { stream: createMockStream(loopingChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }

    // 2-param API: no detector argument
    const config: UnstuckConfig = { ...defaultConfig, maxNudges: 2, strategy: "nudge" }
    const wrapped = wrapWithLoopDetection(model, config)

    const initialMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First response" },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "Second response" },
      { role: "assistant", content: "Third response" },
    ]

    const result = await collectStream(wrapped, initialMessages)

    expect(result.length).toBeGreaterThan(0)
    // 2 doStream calls: original (with inline evidence gating) + nudge
    expect(callCount).toBe(2)

    // Second call should have all original messages plus the nudge (nothing pruned)
    expect(receivedPrompt.length).toBe(initialMessages.length + 1)
    expect(receivedPrompt[receivedPrompt.length - 1].role).toBe("user")
    const lastContent = receivedPrompt[receivedPrompt.length - 1].content as Array<{ type: string; text: string }>
    expect(lastContent[0]?.text).toContain("stuck in a loop")
  })
})

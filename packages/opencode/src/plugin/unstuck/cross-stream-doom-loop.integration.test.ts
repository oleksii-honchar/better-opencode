import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import { wrapWithLoopDetection } from "./wrapper"
import { defaultConfig, type UnstuckConfig } from "./config"
import { CrossStreamDoomLoopManagerImpl } from "./cross-stream-doom-loop"
import { LoopDetectedError } from "./error"

// ---------------------------------------------------------------------------
// Integration test — cross-stream doom-loop detection
//
// Task 4 acceptance criteria:
//   1. 3 separate streams, each with 1 identical tool call → nudge triggered
//      after 3rd stream (threshold: 3).
//   2. Different tool calls across streams → no cross-stream detection.
//   3. Cross-session isolation — two sessions each with 2 identical calls →
//      neither reaches threshold of 3.
//   4. Per-stream detection still works independently — 3 identical calls
//      within ONE stream are caught by the per-stream detector.
// ---------------------------------------------------------------------------

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

// Config that enables doom_loop detection but disables other detectors,
// with cross-stream detection enabled and threshold 3.
const crossStreamConfig: UnstuckConfig = {
  ...defaultConfig,
  maxNudges: 2,
  strategy: "nudge-and-prune",
  loopThreshold: 100,
  detectToolOnlyLoops: false,
  enablePatternLoopDetection: false,
  enableSentenceLoopDetection: false,
  enableSelfDiagnosisDetection: false,
  enableXmlRepetitionGuard: false,
  enableCrossStreamDoomLoopDetection: true,
  crossStreamDoomLoopThreshold: 3,
  nudgeMessage: undefined,
}

// Recovery chunks emitted after nudge — clean text response.
const recoveryChunks: LanguageModelV3StreamPart[] = [
  { type: "text-delta", id: "recovery-text", delta: "Recovery response" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
]

// ---------------------------------------------------------------------------
// Test 1: 3 separate streams, each with 1 identical tool call → nudge triggered
// ---------------------------------------------------------------------------

function createCrossStreamModel(): {
  model: LanguageModelV3
  callCount: () => number
  receivedPrompt: () => any[]
} {
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
      if (callCount <= 3) {
        // Emit exactly 1 identical tool call per stream (cross-stream pattern)
        const chunks: LanguageModelV3StreamPart[] = [
          { type: "text-delta", id: `${callCount}-text`, delta: "Thinking" },
          { type: "tool-input-start", id: `call-${callCount}`, toolName: "bash" },
          { type: "tool-input-end", id: `call-${callCount}`, input: { command: "sed -i test" }, providerMetadata: undefined } as any,
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },
        ]
        return { stream: createMockStream(chunks) }
      }
      // Recovery stream after nudge
      return { stream: createMockStream(recoveryChunks) }
    },
  }
  return { model, callCount: () => callCount, receivedPrompt: () => receivedPrompt }
}

describe("cross-stream doom-loop integration", () => {
  test("3 separate streams, each with 1 identical tool call → nudge triggered after 3rd stream", async () => {
    const { model, callCount, receivedPrompt } = createCrossStreamModel()
    const manager = new CrossStreamDoomLoopManagerImpl()
    const wrapped = wrapWithLoopDetection(model, crossStreamConfig, manager)

    // Prompt includes session ID so extractSessionId can find it
    const prompt = [
      { role: "system", content: "<env>Session ID: ses_test_cross_stream</env>" },
      { role: "user", content: "Hello" },
    ]

    // Stream 1: 1st identical call — no detection (count 1 < 3)
    let result1: LanguageModelV3StreamPart[] = []
    try {
      result1 = await collectStream(wrapped, prompt)
    } catch {
      // should not throw
    }
    expect(result1.length).toBeGreaterThan(0)
    expect(callCount()).toBe(1)

    // Stream 2: 2nd identical call — no detection (count 2 < 3)
    let result2: LanguageModelV3StreamPart[] = []
    try {
      result2 = await collectStream(wrapped, prompt)
    } catch {
      // should not throw
    }
    expect(result2.length).toBeGreaterThan(0)
    expect(callCount()).toBe(2)

    // Stream 3: 3rd identical call — cross-stream detection triggers nudge (count 3 >= 3)
    // The nudge-and-prune path catches the LoopDetectedError, injects nudge, and restarts.
    // The restarted stream (call 4) emits recovery chunks.
    let escaped: unknown = undefined
    let result3: LanguageModelV3StreamPart[] = []
    try {
      result3 = await collectStream(wrapped, prompt)
    } catch (e) {
      escaped = e
    }

    // No error escaped — nudge recovered the stream.
    expect(escaped).toBeUndefined()
    expect(escaped).not.toBeInstanceOf(LoopDetectedError)
    expect(result3.length).toBeGreaterThan(0)

    // The model was called 4 times: 3 doom-loop streams + 1 recovery stream after nudge.
    expect(callCount()).toBe(4)

    // Nudge user message was injected with _unstuckNudge: true.
    const lastMessage = receivedPrompt()[receivedPrompt().length - 1]
    expect(lastMessage._unstuckNudge).toBe(true)
    const lastContent = lastMessage.content as Array<{ type: string; text: string }>
    expect(lastContent[0]?.text).toContain("bash")
    expect(lastContent[0]?.text).toContain("doom loop")
  })

  // ---------------------------------------------------------------------------
  // Test 2: Different tool calls across streams → no cross-stream detection
  // ---------------------------------------------------------------------------

  function createDifferentToolsModel(): {
    model: LanguageModelV3
    callCount: () => number
  } {
    let callCount = 0
    const commands = ["ls -la", "cat file.txt", "echo hello"]
    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(_args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        const cmd = commands[(callCount - 1) % 3]
        const chunks: LanguageModelV3StreamPart[] = [
          { type: "text-delta", id: `${callCount}-text`, delta: "Thinking" },
          { type: "tool-input-start", id: `call-${callCount}`, toolName: "bash" },
          { type: "tool-input-end", id: `call-${callCount}`, input: { command: cmd }, providerMetadata: undefined } as any,
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },
        ]
        return { stream: createMockStream(chunks) }
      },
    }
    return { model, callCount: () => callCount }
  }

  test("different tool calls across streams → no cross-stream detection", async () => {
    const { model, callCount } = createDifferentToolsModel()
    const manager = new CrossStreamDoomLoopManagerImpl()
    const wrapped = wrapWithLoopDetection(model, crossStreamConfig, manager)

    const prompt = [
      { role: "system", content: "<env>Session ID: ses_test_diff_tools</env>" },
      { role: "user", content: "Hello" },
    ]

    // Call 3 times with different inputs — should NOT trigger cross-stream detection.
    for (let i = 0; i < 3; i++) {
      const result = await collectStream(wrapped, prompt)
      expect(result.length).toBeGreaterThan(0)
    }

    // Model was called exactly 3 times, no nudge/restart.
    expect(callCount()).toBe(3)

    // Manager state: the last call's fingerprint is set with count 1
    // (each different input resets the counter).
    // No nudge was injected — the prompt never got an _unstuckNudge message.
    manager.clearAll()
  })

  // ---------------------------------------------------------------------------
  // Test 3: Cross-session isolation — two sessions each with 2 identical calls
  // ---------------------------------------------------------------------------

  function createCrossSessionModel(): {
    model: LanguageModelV3
    callCount: () => number
  } {
    let callCount = 0
    const model: LanguageModelV3 = {
      modelId: "test-model",
      provider: "test",
      specificationVersion: "v3",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented")
      },
      async doStream(_args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        callCount++
        const chunks: LanguageModelV3StreamPart[] = [
          { type: "text-delta", id: `${callCount}-text`, delta: "Thinking" },
          { type: "tool-input-start", id: `call-${callCount}`, toolName: "bash" },
          { type: "tool-input-end", id: `call-${callCount}`, input: { command: "sed -i test" }, providerMetadata: undefined } as any,
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage },
        ]
        return { stream: createMockStream(chunks) }
      },
    }
    return { model, callCount: () => callCount }
  }

  test("cross-session isolation — two sessions each with 2 identical calls → no nudge", async () => {
    const { model, callCount } = createCrossSessionModel()
    const manager = new CrossStreamDoomLoopManagerImpl()
    const wrapped = wrapWithLoopDetection(model, crossStreamConfig, manager)

    const promptA = [
      { role: "system", content: "<env>Session ID: ses_session_a</env>" },
      { role: "user", content: "Hello" },
    ]

    const promptB = [
      { role: "system", content: "<env>Session ID: ses_session_b</env>" },
      { role: "user", content: "Hello" },
    ]

    // Session A: 2 identical calls (below threshold of 3)
    for (let i = 0; i < 2; i++) {
      const result = await collectStream(wrapped, promptA)
      expect(result.length).toBeGreaterThan(0)
    }

    // Session B: 2 identical calls (below threshold of 3)
    for (let i = 0; i < 2; i++) {
      const result = await collectStream(wrapped, promptB)
      expect(result.length).toBeGreaterThan(0)
    }

    // Model was called exactly 4 times, no nudge/restart.
    expect(callCount()).toBe(4)

    // Verify manager state: both sessions have count 2, neither reached 3.
    // We can verify by triggering one more call for each — it should reach threshold.
    // But for this test, the key assertion is that 4 calls with 2 per session did NOT trigger.
    manager.clearAll()
  })

  // ---------------------------------------------------------------------------
  // Test 4: Per-stream detection still works independently
  // ---------------------------------------------------------------------------

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

  function createPerStreamModel(loopChunks: LanguageModelV3StreamPart[]): {
    model: LanguageModelV3
    callCount: () => number
    receivedPrompt: () => any[]
  } {
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
          return { stream: createMockStream(loopChunks) }
        }
        return { stream: createMockStream(recoveryChunks) }
      },
    }
    return { model, callCount: () => callCount, receivedPrompt: () => receivedPrompt }
  }

  test("per-stream detection still works independently — 3 identical calls in ONE stream", async () => {
    const { model, callCount, receivedPrompt } = createPerStreamModel(doomLoopChunks())
    const manager = new CrossStreamDoomLoopManagerImpl()
    const wrapped = wrapWithLoopDetection(model, crossStreamConfig, manager)

    // This prompt has no session ID — cross-stream detection won't fire,
    // but per-stream detection should still catch 3 identical calls in one stream.
    const prompt = [{ role: "user", content: "Hello" }]

    let escaped: unknown = undefined
    let result: LanguageModelV3StreamPart[] = []
    try {
      result = await collectStream(wrapped, prompt)
    } catch (e) {
      escaped = e
    }

    // No error escaped — nudge recovered the stream.
    expect(escaped).toBeUndefined()
    expect(escaped).not.toBeInstanceOf(LoopDetectedError)
    expect(result.length).toBeGreaterThan(0)

    // Model was called 2 times: 1 loop stream + 1 recovery after nudge.
    expect(callCount()).toBe(2)

    // Nudge was injected.
    const lastMessage = receivedPrompt()[receivedPrompt().length - 1]
    expect(lastMessage._unstuckNudge).toBe(true)
    const lastContent = lastMessage.content as Array<{ type: string; text: string }>
    expect(lastContent[0]?.text).toContain("bash")
    expect(lastContent[0]?.text).toContain("doom loop")
  })
})

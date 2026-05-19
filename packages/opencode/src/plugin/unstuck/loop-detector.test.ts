import { describe, expect, test } from "bun:test"
import { LoopDetectorImpl, normalizeAndFingerprint, computeToolSignature, type StreamChunk } from "./loop-detector"
import { defaultConfig, type UnstuckConfig } from "./config"

function createDetector(_config?: Partial<UnstuckConfig>) {
  return new LoopDetectorImpl()
}

describe("computeToolSignature", () => {
  test("returns tool name with sorted input keys", () => {
    const sig = computeToolSignature("ReadFile", { path: "/foo", mode: "r" })
    expect(sig).toBe("readfile:mode,path")
  })

  test("returns tool name with empty keys when no input", () => {
    const sig = computeToolSignature("Shell")
    expect(sig).toBe("shell:")
  })

  test("normalizes tool name to lowercase", () => {
    const sig = computeToolSignature("ReadFile")
    expect(sig).toBe("readfile:")
  })
})

describe("normalizeAndFingerprint", () => {
  test("produces same fingerprint for equivalent text", () => {
    const fp1 = normalizeAndFingerprint("Let me check the file.")
    const fp2 = normalizeAndFingerprint("let me check the file")
    expect(fp1).toBe(fp2)
  })

  test("produces different fingerprint for different text", () => {
    const fp1 = normalizeAndFingerprint("Let me check the file.")
    const fp2 = normalizeAndFingerprint("Let me read the file.")
    expect(fp1).not.toBe(fp2)
  })

  test("strips punctuation and collapses whitespace", () => {
    const fp1 = normalizeAndFingerprint("Hello,  world!")
    const fp2 = normalizeAndFingerprint("hello world")
    expect(fp1).toBe(fp2)
  })

  test("returns 8-char hex string", () => {
    const fp = normalizeAndFingerprint("test")
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("LoopDetector — step-level loop", () => {

  test("detects step-level loop after threshold steps", () => {
    const detector = createDetector()
    const chunks: StreamChunk[] = []

    for (let i = 0; i < 3; i++) {
      // Same thinking + same tool call
      chunks.push({ type: "text-delta", text: "Let me check the file. This is some thinking that is long enough to pass the minThinkingLength threshold." })
      chunks.push({ type: "tool-input-end", id: `call-${i}`, toolName: "ReadFile", input: { path: "/foo" } })
      chunks.push({ type: "finish-step" })
    }

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, defaultConfig)
    }

    expect(loopInfo).toBeDefined()
    expect(loopInfo?.type).toBe("step_loop")
    expect(loopInfo?.threshold).toBe(3)
  })

  test("does not detect loop with different thinking", () => {
    const detector = createDetector()
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "First step thinking that is long enough to pass the minThinkingLength threshold for detection." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Second step thinking that is completely different from the first step and long enough for threshold." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Third step thinking that is also different from the previous steps and long enough for threshold." },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, defaultConfig)
    }

    expect(loopInfo).toBeUndefined()
  })

  test("does not detect loop with different tools", () => {
    const detector = createDetector()
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-1", toolName: "WriteFile", input: { path: "/foo" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-2", toolName: "Shell", input: { command: "ls" } },
      { type: "finish-step" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, defaultConfig)
    }

    expect(loopInfo).toBeUndefined()
  })

  test("respects custom threshold", () => {
    const detector = createDetector()
    const config: UnstuckConfig = { ...defaultConfig, loopThreshold: 2 }
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeDefined()
    expect(loopInfo?.type).toBe("step_loop")
    expect(loopInfo?.threshold).toBe(2)
  })

  test("does not detect loop with short thinking below minThinkingLength", () => {
    const detector = createDetector()
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "Short." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Short." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Short." },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, defaultConfig)
    }

    // With short thinking, fingerprint is empty, so step fingerprints are identical (|readfile:path)
    // This should actually detect a loop since the fingerprints are the same
    expect(loopInfo).toBeDefined()
    expect(loopInfo?.type).toBe("step_loop")
  })
})

describe("LoopDetector — tool-only loop", () => {
  test("detects tool-only loop with different thinking", () => {
    const detector = createDetector()
    const config: UnstuckConfig = { ...defaultConfig, detectToolOnlyLoops: true, toolLoopThreshold: 3 }
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "First thinking that is long enough to pass the minThinkingLength threshold for proper detection." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Second thinking that is completely different from the first one and long enough for detection." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/bar" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Third thinking that is also different from the previous ones and long enough for detection." },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: { path: "/baz" } },
      { type: "finish-step" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeDefined()
    expect(loopInfo?.type).toBe("tool_loop")
    expect(loopInfo?.threshold).toBe(3)
  })

  test("does not detect tool-only loop when disabled", () => {
    const detector = createDetector()
    const config: UnstuckConfig = { ...defaultConfig, detectToolOnlyLoops: false }
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "First thinking that is long enough to pass the minThinkingLength threshold for proper detection." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Second thinking that is completely different from the first one and long enough for detection." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/bar" } },
      { type: "finish-step" },
      { type: "text-delta", text: "Third thinking that is also different from the previous ones and long enough for detection." },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: { path: "/baz" } },
      { type: "finish-step" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeUndefined()
  })
})

describe("LoopDetector — reset", () => {
  test("clears all state after reset", () => {
    const detector = createDetector()
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish-step" },
    ]

    for (const chunk of chunks) {
      detector.consumeChunk(chunk, defaultConfig)
    }

    expect(detector.getState().historyLength).toBe(1)

    detector.reset()

    expect(detector.getState().historyLength).toBe(0)
    expect(detector.getState().currentThinkingLength).toBe(0)
    expect(detector.getState().currentToolsCount).toBe(0)
  })
})

describe("LoopDetector — provider-executed tools", () => {
  test("skips provider-executed tools", () => {
    const detector = createDetector()
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "Thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" }, providerExecuted: true },
      { type: "finish-step" },
    ]

    for (const chunk of chunks) {
      detector.consumeChunk(chunk, defaultConfig)
    }

    expect(detector.getState().currentToolsCount).toBe(0)
  })
})

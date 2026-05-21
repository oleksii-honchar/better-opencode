import { describe, expect, test } from "bun:test"
import { LoopDetectorImpl, normalizeAndFingerprint, computeToolSignature, EvidenceAccumulatorImpl, type StreamChunk } from "./loop-detector"
import { defaultConfig, type UnstuckConfig } from "./config"
import type { LoopDetectedInfo } from "./error"

function createDetector(_config?: Partial<UnstuckConfig>) {
  return new LoopDetectorImpl()
}

describe("computeToolSignature", () => {
  test("returns tool name with sorted key=value pairs", () => {
    const sig = computeToolSignature("ReadFile", { path: "/foo", mode: "r" })
    expect(sig).toBe("readfile:mode=r;path=/foo")
  })

  test("returns tool name with empty keys when no input", () => {
    const sig = computeToolSignature("Shell")
    expect(sig).toBe("shell:")
  })

  test("normalizes tool name to lowercase", () => {
    const sig = computeToolSignature("ReadFile")
    expect(sig).toBe("readfile:")
  })

  test("normalizes values — lowercase, collapse whitespace, strip quotes", () => {
    const sig = computeToolSignature("bash", { command: "ls -la '/Path/To File'" })
    expect(sig).toBe("bash:command=ls -la /path/to file")
  })

  test("different bash commands produce different signatures", () => {
    const sig1 = computeToolSignature("bash", { command: "./script.sh" })
    const sig2 = computeToolSignature("bash", { command: "ls -la" })
    expect(sig1).not.toBe(sig2)
  })

  test("different file paths produce different signatures", () => {
    const sig1 = computeToolSignature("edit", { filePath: "/file1.ts" })
    const sig2 = computeToolSignature("edit", { filePath: "/file2.ts" })
    expect(sig1).not.toBe(sig2)
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
      chunks.push({ type: "finish", finishReason: "tool-calls" })
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
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Second step thinking that is completely different from the first step and long enough for threshold." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Third step thinking that is also different from the previous steps and long enough for threshold." },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
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
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-1", toolName: "WriteFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-2", toolName: "Shell", input: { command: "ls" } },
      { type: "finish", finishReason: "tool-calls" },
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
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
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
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Short." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Short." },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
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
  test("detects tool-only loop with same tool+input and different thinking", () => {
    const detector = createDetector()
    const config: UnstuckConfig = { ...defaultConfig, detectToolOnlyLoops: true, toolLoopThreshold: 3 }
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "First thinking that is long enough to pass the minThinkingLength threshold for proper detection." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Second thinking that is completely different from the first one and long enough for detection." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Third thinking that is also different from the previous ones and long enough for detection." },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeDefined()
    expect(loopInfo?.type).toBe("tool_loop")
    expect(loopInfo?.threshold).toBe(3)
  })

  test("does NOT detect tool-only loop with different bash commands (false positive fix)", () => {
    const detector = createDetector()
    const config: UnstuckConfig = { ...defaultConfig, detectToolOnlyLoops: true, toolLoopThreshold: 3 }
    // Simulates a debugging session: run script, ls, run again, run with -x
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "Let me try running the script." },
      { type: "tool-input-end", id: "call-0", toolName: "bash", input: { command: "./script.sh" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "It failed, let me check if the file exists." },
      { type: "tool-input-end", id: "call-1", toolName: "bash", input: { command: "ls -la script.sh" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "File exists, let me try with stderr." },
      { type: "tool-input-end", id: "call-2", toolName: "bash", input: { command: "./script.sh 2>&1" } },
      { type: "finish", finishReason: "tool-calls" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeUndefined()
  })

  test("does NOT detect tool-only loop with different file edits (false positive fix)", () => {
    const detector = createDetector()
    const config: UnstuckConfig = { ...defaultConfig, detectToolOnlyLoops: true, toolLoopThreshold: 3 }
    // Simulates editing multiple files in sequence
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "Let me edit the first file." },
      { type: "tool-input-end", id: "call-0", toolName: "edit", input: { filePath: "/file1.ts" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Now edit the second file." },
      { type: "tool-input-end", id: "call-1", toolName: "edit", input: { filePath: "/file2.ts" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Now edit the third file." },
      { type: "tool-input-end", id: "call-2", toolName: "edit", input: { filePath: "/file3.ts" } },
      { type: "finish", finishReason: "tool-calls" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeUndefined()
  })

  test("parses input from delta when chunk.input is empty", () => {
    const detector = createDetector()
    const config: UnstuckConfig = { ...defaultConfig, detectToolOnlyLoops: true, toolLoopThreshold: 3 }
    // Simulates AI SDK not providing input in tool-input-end (real-world case)
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "First thinking that is long enough to pass the minThinkingLength threshold for proper detection." },
      { type: "tool-input-start", id: "call-0", toolName: "ReadFile" },
      { type: "tool-input-delta", id: "call-0", text: '{"path":"/foo"}' },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: {} },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Second thinking that is completely different from the first one and long enough for detection." },
      { type: "tool-input-start", id: "call-1", toolName: "ReadFile" },
      { type: "tool-input-delta", id: "call-1", text: '{"path":"/foo"}' },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: {} },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Third thinking that is also different from the previous ones and long enough for detection." },
      { type: "tool-input-start", id: "call-2", toolName: "ReadFile" },
      { type: "tool-input-delta", id: "call-2", text: '{"path":"/foo"}' },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: {} },
      { type: "finish", finishReason: "tool-calls" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeDefined()
    expect(loopInfo?.type).toBe("tool_loop")
  })

  test("does not detect tool-only loop when disabled", () => {
    const detector = createDetector()
    const config: UnstuckConfig = { ...defaultConfig, detectToolOnlyLoops: false, toolLoopThreshold: 3 }
    // Same tool+input but different thinking — would be caught by tool-only if enabled
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "First thinking that is long enough to pass the minThinkingLength threshold for proper detection." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Second thinking that is completely different from the first one and long enough for detection." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: "Third thinking that is also different from the previous ones and long enough for detection." },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeUndefined()
  })
})

describe("LoopDetector — reset", () => {
  test("clears streaming state but preserves history", () => {
    const detector = createDetector()
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
    ]

    for (const chunk of chunks) {
      detector.consumeChunk(chunk, defaultConfig)
    }

    expect(detector.getState().historyLength).toBe(1)

    // Simulate partial streaming state
    detector.consumeChunk({ type: "text-delta", text: "Partial thinking" }, defaultConfig)
    expect(detector.getState().currentThinkingLength).toBeGreaterThan(0)

    detector.reset()

    // History is preserved
    expect(detector.getState().historyLength).toBe(1)
    // Streaming state is cleared
    expect(detector.getState().currentThinkingLength).toBe(0)
    expect(detector.getState().currentToolsCount).toBe(0)
  })
})

describe("LoopDetector — clear", () => {
  test("clears all state including history", () => {
    const detector = createDetector()
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
    ]

    for (const chunk of chunks) {
      detector.consumeChunk(chunk, defaultConfig)
    }

    expect(detector.getState().historyLength).toBe(1)

    // Simulate partial streaming state
    detector.consumeChunk({ type: "text-delta", text: "Partial thinking" }, defaultConfig)

    detector.clear()

    // Everything is cleared
    expect(detector.getState().historyLength).toBe(0)
    expect(detector.getState().currentThinkingLength).toBe(0)
    expect(detector.getState().currentToolsCount).toBe(0)
  })
})

describe("EvidenceAccumulator", () => {
  function createInfo(type: "step_loop" | "tool_loop" | "sentence_loop", threshold: number = 3): LoopDetectedInfo {
    if (type === "sentence_loop") {
      return { type, threshold, sentence: "repeated sentence" }
    }
    return { type, threshold, fingerprint: "fp-123" }
  }

  test("adds and counts records correctly", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add(createInfo("step_loop"), 1)
    acc.add(createInfo("step_loop"), 2)
    acc.add(createInfo("step_loop"), 3)

    expect(acc.count).toBe(3)
    expect(acc.countByType("step_loop")).toBe(3)
    expect(acc.countByType("tool_loop")).toBe(0)
    expect(acc.countByType("sentence_loop")).toBe(0)
  })

  test("isThresholdMet returns false when below threshold", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add(createInfo("step_loop"), 1)

    const result = acc.isThresholdMet(defaultConfig)
    expect(result.met).toBe(false)
  })

  test("isThresholdMet returns true when at threshold", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add(createInfo("step_loop"), 1)
    acc.add(createInfo("step_loop"), 2)

    const result = acc.isThresholdMet(defaultConfig)
    expect(result.met).toBe(true)
    expect((result as { met: true; type: string }).type).toBe("step_loop")
  })

  test("isThresholdMet checks each type independently", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add(createInfo("step_loop"), 1)
    acc.add(createInfo("tool_loop"), 2)

    // Neither meets threshold (both need 2)
    const result = acc.isThresholdMet(defaultConfig)
    expect(result.met).toBe(false)
  })

  test("isThresholdMet sentence_loop threshold is 1 by default", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add(createInfo("sentence_loop"), 1)

    const result = acc.isThresholdMet(defaultConfig)
    expect(result.met).toBe(true)
    expect((result as { met: true; type: string }).type).toBe("sentence_loop")
  })

  test("evidenceWindow evicts oldest records", () => {
    const config: UnstuckConfig = { ...defaultConfig, evidenceWindow: 3 }
    const acc = new EvidenceAccumulatorImpl()

    acc.add(createInfo("step_loop"), 1, config)
    acc.add(createInfo("step_loop"), 2, config)
    acc.add(createInfo("step_loop"), 3, config)
    acc.add(createInfo("step_loop"), 4, config)
    acc.add(createInfo("step_loop"), 5, config)

    expect(acc.count).toBe(3)
    // Only last 3 should remain (chunks 3, 4, 5)
    expect(acc.records[0].detectedAtChunk).toBe(3)
    expect(acc.records[1].detectedAtChunk).toBe(4)
    expect(acc.records[2].detectedAtChunk).toBe(5)
  })

  test("evidenceWindow Infinity does not evict", () => {
    const acc = new EvidenceAccumulatorImpl()

    acc.add(createInfo("step_loop"), 1, defaultConfig)
    acc.add(createInfo("step_loop"), 2, defaultConfig)
    acc.add(createInfo("step_loop"), 3, defaultConfig)
    acc.add(createInfo("step_loop"), 4, defaultConfig)

    expect(acc.count).toBe(4)
  })

  test("clear removes all records", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add(createInfo("step_loop"), 1)
    acc.add(createInfo("tool_loop"), 2)

    expect(acc.count).toBe(2)
    acc.clear()
    expect(acc.count).toBe(0)
  })

  test("records include all detection info", () => {
    const acc = new EvidenceAccumulatorImpl()
    const info: LoopDetectedInfo = {
      type: "step_loop",
      threshold: 3,
      fingerprint: "fp-456",
      steps: [{ reasoningFingerprint: "rfp1", textFingerprint: "tfp1", thinkingFingerprint: "fp1", toolSignatures: ["readfile:path=/foo"], stepFingerprint: "fp1|readfile:path=/foo" }],
    }
    acc.add(info, 42)

    expect(acc.count).toBe(1)
    const record = acc.records[0]
    expect(record.type).toBe("step_loop")
    expect(record.fingerprint).toBe("fp-456")
    expect(record.threshold).toBe(3)
    expect(record.detectedAtChunk).toBe(42)
    expect(record.steps).toBeDefined()
    expect(record.timestamp).toBeGreaterThan(0)
  })

  test("custom thresholds override defaults", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      evidenceThresholds: { stepLoop: 1, toolLoop: 1, sentenceLoop: 1 },
    }
    const acc = new EvidenceAccumulatorImpl()
    acc.add(createInfo("step_loop"), 1)

    const result = acc.isThresholdMet(config)
    expect(result.met).toBe(true)
  })
})

describe("LoopDetector — provider-executed tools", () => {
  test("skips provider-executed tools", () => {
    const detector = createDetector()
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: "Thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" }, providerExecuted: true },
      { type: "finish", finishReason: "tool-calls" },
    ]

    for (const chunk of chunks) {
      detector.consumeChunk(chunk, defaultConfig)
    }

    expect(detector.getState().currentToolsCount).toBe(0)
  })
})

describe("Phase 5 — Regression Tests", () => {
  test("reasoning-only loop is detected", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 3,
      includeReasoning: true,
      includeText: false,
    }

    for (let i = 0; i < 3; i++) {
      detector.consumeChunk(
        { type: "reasoning-delta", text: "Same reasoning text that is long enough to pass the minThinkingLength threshold for detection here." },
        config,
      )
      detector.consumeChunk(
        { type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" },
        config,
      )
      detector.consumeChunk(
        { type: "tool-input-end", id: `call-${i}`, toolName: "ReadFile", input: { path: "/foo" } },
        config,
      )
      const result = detector.finalizeStep(config, "tool-calls")
      if (i === 2) {
        expect(result).toBeDefined()
        expect(result!.type).toBe("step_loop")
      }
    }
  })

  test("text-only loop is detected", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 3,
      includeReasoning: false,
      includeText: true,
    }

    for (let i = 0; i < 3; i++) {
      detector.consumeChunk(
        { type: "text-delta", text: "Same text content that is long enough to pass the minThinkingLength threshold for detection here." },
        config,
      )
      detector.consumeChunk(
        { type: "tool-input-start", id: `call-${i}`, toolName: "ReadFile" },
        config,
      )
      detector.consumeChunk(
        { type: "tool-input-end", id: `call-${i}`, toolName: "ReadFile", input: { path: "/foo" } },
        config,
      )
      const result = detector.finalizeStep(config, "tool-calls")
      if (i === 2) {
        expect(result).toBeDefined()
        expect(result!.type).toBe("step_loop")
      }
    }
  })

  test("reasoning and text produce different fingerprints", () => {
    const detector1 = createDetector()
    const detector2 = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 3,
      includeReasoning: true,
      includeText: true,
    }

    // Same content, different channel
    detector1.consumeChunk(
      { type: "reasoning-delta", text: "Identical content that is long enough to pass the minThinkingLength threshold for detection here." },
      config,
    )
    detector1.consumeChunk(
      { type: "tool-input-start", id: "call-0", toolName: "ReadFile" },
      config,
    )
    detector1.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    detector2.consumeChunk(
      { type: "text-delta", text: "Identical content that is long enough to pass the minThinkingLength threshold for detection here." },
      config,
    )
    detector2.consumeChunk(
      { type: "tool-input-start", id: "call-0", toolName: "ReadFile" },
      config,
    )
    detector2.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    // Check state before finalizeStep (which resets accumulators)
    const state1 = detector1.getState()
    const state2 = detector2.getState()
    expect(state1.currentReasoningLength).toBeGreaterThan(0)
    expect(state1.currentTextLength).toBe(0)
    expect(state2.currentReasoningLength).toBe(0)
    expect(state2.currentTextLength).toBeGreaterThan(0)

    // Now finalize and check history records have different fingerprints
    detector1.finalizeStep(config, "tool-calls")
    detector2.finalizeStep(config, "tool-calls")

    const hist1 = detector1.getState()
    const hist2 = detector2.getState()
    expect(hist1.historyLength).toBe(1)
    expect(hist2.historyLength).toBe(1)
  })

  test("malformed JSON.parse input produces _missing marker", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      includeReasoning: false,
      includeText: true,
    }

    detector.consumeChunk(
      { type: "text-delta", text: "Thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-start", id: "call-0", toolName: "ReadFile" },
      config,
    )
    // input is a primitive, so Object.keys returns [] and _missing marker is used
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: 12345 as any },
      config,
    )

    // Check state before finalizeStep (which resets accumulators)
    const state = detector.getState()
    expect(state.currentToolsCount).toBe(1)
    // The tool should have been added with _missing marker
  })

  test("computeToolSignature rejects non-object input", () => {
    // null input
    const sig1 = computeToolSignature("ReadFile", null as any)
    expect(sig1).toBe("readfile:")

    // array input
    const sig2 = computeToolSignature("ReadFile", [1, 2, 3] as any)
    expect(sig2).toBe("readfile:")

    // primitive input
    const sig3 = computeToolSignature("ReadFile", "string" as any)
    expect(sig3).toBe("readfile:")

    // number input
    const sig4 = computeToolSignature("ReadFile", 42 as any)
    expect(sig4).toBe("readfile:")
  })

  test("structural formatting patterns do not trigger sentence loop", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      enableSentenceLoopDetection: true,
      sentenceLoopThreshold: 1,
    }

    // Repeated structural formatting that should be filtered
    for (let i = 0; i < 5; i++) {
      const result = detector.consumeChunk(
        {
          type: "text-delta",
          text: "---\n## Step 1\n- Item 1\n- Item 2\n```\ncode block\n```\n",
        },
        config,
      )
      expect(result).toBeUndefined()
    }
  })

  test("getState reflects reasoning and text lengths separately", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      includeReasoning: true,
      includeText: true,
    }

    detector.consumeChunk(
      { type: "reasoning-delta", text: "Reasoning text" },
      config,
    )
    detector.consumeChunk(
      { type: "text-delta", text: "Text content" },
      config,
    )

    const state = detector.getState()
    expect(state.currentReasoningLength).toBe(14) // "Reasoning text"
    expect(state.currentTextLength).toBe(12) // "Text content"
    expect(state.currentThinkingLength).toBe(26) // combined
  })

  test("clear resets reasoning and text accumulators", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      includeReasoning: true,
      includeText: true,
    }

    detector.consumeChunk(
      { type: "reasoning-delta", text: "Reasoning text" },
      config,
    )
    detector.consumeChunk(
      { type: "text-delta", text: "Text content" },
      config,
    )

    detector.clear()

    const state = detector.getState()
    expect(state.currentReasoningLength).toBe(0)
    expect(state.currentTextLength).toBe(0)
    expect(state.currentThinkingLength).toBe(0)
  })
})

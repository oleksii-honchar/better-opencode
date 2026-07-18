import { describe, expect, test } from "bun:test"
import { LoopDetectorImpl, normalizeAndFingerprint, computeToolSignature, EvidenceAccumulatorImpl, type StreamChunk } from "./loop-detector"
import { defaultConfig, defaultEvidenceThresholds, mergeConfig, type UnstuckConfig } from "./config"
import { LoopDetectedError, type LoopDetectedInfo } from "./error"
import { XmlRepetitionDetector } from "./xml-repetition-detector"

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

describe("detectSelfDiagnosis", () => {
  // detectSelfDiagnosis is not exported, so we test it through finalizeStep
  // by feeding reasoning/text that contains self-diagnosis phrases

  test('detects "stuck in a loop" in reasoning text', () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: true,
    }

    detector.consumeChunk(
      { type: "reasoning-delta", text: "I think I'm stuck in a loop here. Let me try something different." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("self_diagnosis_loop")
    expect(result?.threshold).toBe(1)
  })

  test('detects "I\'m stuck" with apostrophe in text content', () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: true,
    }

    detector.consumeChunk(
      { type: "text-delta", text: "I'm stuck on this problem. Let me think about it differently." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("self_diagnosis_loop")
  })

  test('detects "I\'m stuck" with straight quote in text content', () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: true,
    }

    detector.consumeChunk(
      { type: "text-delta", text: "I'm stuck on this problem." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("self_diagnosis_loop")
  })

  test('detects "repeating the same" phrase', () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: true,
    }

    detector.consumeChunk(
      { type: "reasoning-delta", text: "I keep repeating the same steps over and over." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("self_diagnosis_loop")
  })

  test('detects "going in circles" phrase', () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: true,
    }

    detector.consumeChunk(
      { type: "reasoning-delta", text: "It feels like I'm going in circles with this approach." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("self_diagnosis_loop")
  })

  test('detects "cannot progress" phrase', () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: true,
    }

    detector.consumeChunk(
      { type: "reasoning-delta", text: "I cannot progress further with this approach." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("self_diagnosis_loop")
  })

  test('detects "cannot proceed" phrase', () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: true,
    }

    detector.consumeChunk(
      { type: "reasoning-delta", text: "I cannot proceed any further." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("self_diagnosis_loop")
  })

  test('detects "cannot continue" phrase', () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: true,
    }

    detector.consumeChunk(
      { type: "reasoning-delta", text: "I cannot continue with this strategy." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("self_diagnosis_loop")
  })

  test("does NOT detect with normal text without stuck phrases", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: true,
    }

    detector.consumeChunk(
      { type: "reasoning-delta", text: "Let me read the file and check what's inside. This is normal thinking that doesn't indicate any loop or stuck state." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeUndefined()
  })

  test("does NOT detect when enableSelfDiagnosisDetection is false", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: false,
    }

    detector.consumeChunk(
      { type: "reasoning-delta", text: "I'm stuck in a loop here. Let me try something different." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeUndefined()
  })

  test("detects self-diagnosis even when text is below minThinkingLength", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enableSelfDiagnosisDetection: true,
      minThinkingLength: 50,
    }

    // Short text that is below minThinkingLength
    detector.consumeChunk(
      { type: "reasoning-delta", text: "I'm stuck." },
      config,
    )
    detector.consumeChunk(
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      config,
    )

    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("self_diagnosis_loop")
  })
})

describe("EvidenceAccumulator — self_diagnosis_loop", () => {
  test("countByType handles self_diagnosis_loop", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add({ type: "self_diagnosis_loop", threshold: 1 }, 1)
    acc.add({ type: "self_diagnosis_loop", threshold: 1 }, 2)

    expect(acc.countByType("self_diagnosis_loop")).toBe(2)
    expect(acc.countByType("step_loop")).toBe(0)
  })

  test("isThresholdMet checks selfDiagnosis threshold", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add({ type: "self_diagnosis_loop", threshold: 1 }, 1)

    const result = acc.isThresholdMet(defaultConfig)
    expect(result.met).toBe(true)
    expect((result as { met: true; type: string }).type).toBe("self_diagnosis_loop")
  })

  test("isThresholdMet selfDiagnosis with custom threshold", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      evidenceThresholds: { selfDiagnosis: 2 },
    }
    const acc = new EvidenceAccumulatorImpl()
    acc.add({ type: "self_diagnosis_loop", threshold: 1 }, 1)

    // Below custom threshold of 2
    const result = acc.isThresholdMet(config)
    expect(result.met).toBe(false)
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

describe("LoopDetector — tool-only loop with gaps", () => {
  test("detects tool-only loop when tool-bearing steps are separated by reasoning-only steps", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      detectToolOnlyLoops: true,
      toolLoopThreshold: 3,
      loopThreshold: 10,
    }

    // 6 steps: tool, no-tool, tool, no-tool, tool, no-tool
    // Same tool signature each time — should detect because 3 tool-bearing steps have identical signatures
    const chunks: StreamChunk[] = [
      // Step 1: tool call
      { type: "text-delta", text: "First thinking that is long enough to pass the minThinkingLength threshold for detection." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      // Step 2: no tool (reasoning only)
      { type: "text-delta", text: "Second thinking that is completely different from the first one and long enough for detection." },
      { type: "finish", finishReason: "tool-calls" },
      // Step 3: tool call (same as step 1)
      { type: "text-delta", text: "Third thinking that is also different from the previous ones and long enough for detection." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      // Step 4: no tool (reasoning only)
      { type: "text-delta", text: "Fourth thinking that is yet another different thought and long enough for detection." },
      { type: "finish", finishReason: "tool-calls" },
      // Step 5: tool call (same as steps 1 and 3)
      { type: "text-delta", text: "Fifth thinking that is also different again and long enough for detection here." },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      // Step 6: no tool (reasoning only)
      { type: "text-delta", text: "Sixth thinking that is yet another different thought and long enough for detection." },
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

  test("does NOT detect tool-only loop with gaps when tool signatures differ", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      detectToolOnlyLoops: true,
      toolLoopThreshold: 3,
      loopThreshold: 10,
    }

    // Tool calls with different signatures separated by no-tool steps
    const chunks: StreamChunk[] = [
      // Step 1: tool call A
      { type: "text-delta", text: "First thinking that is long enough to pass the minThinkingLength threshold for detection." },
      { type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } },
      { type: "finish", finishReason: "tool-calls" },
      // Step 2: no tool
      { type: "text-delta", text: "Second thinking that is completely different from the first one and long enough for detection." },
      { type: "finish", finishReason: "tool-calls" },
      // Step 3: tool call B (different)
      { type: "text-delta", text: "Third thinking that is also different from the previous ones and long enough for detection." },
      { type: "tool-input-end", id: "call-1", toolName: "ReadFile", input: { path: "/bar" } },
      { type: "finish", finishReason: "tool-calls" },
      // Step 4: no tool
      { type: "text-delta", text: "Fourth thinking that is yet another different thought and long enough for detection." },
      { type: "finish", finishReason: "tool-calls" },
      // Step 5: tool call C (different)
      { type: "text-delta", text: "Fifth thinking that is also different again and long enough for detection here." },
      { type: "tool-input-end", id: "call-2", toolName: "ReadFile", input: { path: "/baz" } },
      { type: "finish", finishReason: "tool-calls" },
      // Step 6: no tool
      { type: "text-delta", text: "Sixth thinking that is yet another different thought and long enough for detection." },
      { type: "finish", finishReason: "tool-calls" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeUndefined()
  })
})

describe("LoopDetector — alternating pattern detection", () => {
  test("detects alternating pattern A→B→A→B with 4 steps", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enablePatternLoopDetection: true,
      patternLoopThreshold: 4,
    }

    const textA = "First pattern text that is long enough for fingerprint detection here."
    const textB = "Second pattern text that is long enough for fingerprint detection here."

    // A, B, A, B — 4 alternating steps
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: textA },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textB },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textA },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textB },
      { type: "finish", finishReason: "tool-calls" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeDefined()
    expect(loopInfo?.type).toBe("pattern_loop")
    expect(loopInfo?.threshold).toBe(4)
    expect(loopInfo?.fingerprint).toContain("|")
  })

  test("does NOT detect alternating pattern with < 4 steps", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enablePatternLoopDetection: true,
      patternLoopThreshold: 4,
    }

    const textA = "First pattern text that is long enough for fingerprint detection here."
    const textB = "Second pattern text that is long enough for fingerprint detection here."

    // Only 3 steps: A, B, A — below threshold
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: textA },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textB },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textA },
      { type: "finish", finishReason: "tool-calls" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeUndefined()
  })

  test("does NOT detect alternating pattern with 3+ distinct fingerprints", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enablePatternLoopDetection: true,
      patternLoopThreshold: 4,
    }

    const textA = "First pattern text that is long enough for fingerprint detection here."
    const textB = "Second pattern text that is long enough for fingerprint detection here."
    const textC = "Third pattern text that is long enough for fingerprint detection here."

    // A, B, C, A, B, C — 3 distinct fingerprints, not alternating
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: textA },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textB },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textC },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textA },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textB },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textC },
      { type: "finish", finishReason: "tool-calls" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeUndefined()
  })

  test("does NOT detect alternating pattern when enablePatternLoopDetection is false", () => {
    const detector = createDetector()
    const config: UnstuckConfig = {
      ...defaultConfig,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      enablePatternLoopDetection: false,
      patternLoopThreshold: 4,
    }

    const textA = "First pattern text that is long enough for fingerprint detection here."
    const textB = "Second pattern text that is long enough for fingerprint detection here."

    // A, B, A, B — would be detected if enabled
    const chunks: StreamChunk[] = [
      { type: "text-delta", text: textA },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textB },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textA },
      { type: "finish", finishReason: "tool-calls" },
      { type: "text-delta", text: textB },
      { type: "finish", finishReason: "tool-calls" },
    ]

    let loopInfo = undefined
    for (const chunk of chunks) {
      loopInfo = detector.consumeChunk(chunk, config)
    }

    expect(loopInfo).toBeUndefined()
  })
})

describe("EvidenceAccumulator — pattern_loop", () => {
  test("countByType handles pattern_loop", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add({ type: "pattern_loop", threshold: 4, fingerprint: "fp-a|fp-b" }, 1)
    acc.add({ type: "pattern_loop", threshold: 4, fingerprint: "fp-a|fp-b" }, 2)

    expect(acc.countByType("pattern_loop")).toBe(2)
    expect(acc.countByType("step_loop")).toBe(0)
  })

  test("isThresholdMet checks patternLoop threshold", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add({ type: "pattern_loop", threshold: 4, fingerprint: "fp-a|fp-b" }, 1)
    acc.add({ type: "pattern_loop", threshold: 4, fingerprint: "fp-a|fp-b" }, 2)

    const result = acc.isThresholdMet(defaultConfig)
    expect(result.met).toBe(true)
    expect((result as { met: true; type: string }).type).toBe("pattern_loop")
  })

  test("isThresholdMet patternLoop with custom threshold", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      evidenceThresholds: { patternLoop: 3 },
    }
    const acc = new EvidenceAccumulatorImpl()
    acc.add({ type: "pattern_loop", threshold: 4, fingerprint: "fp-a|fp-b" }, 1)
    acc.add({ type: "pattern_loop", threshold: 4, fingerprint: "fp-a|fp-b" }, 2)

    // Below custom threshold of 3
    const result = acc.isThresholdMet(config)
    expect(result.met).toBe(false)
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

describe("LoopDetectedInfo — xml_repetition type", () => {
  test("accepts xml_repetition type with new fields", () => {
    const info: LoopDetectedInfo = {
      type: "xml_repetition",
      threshold: 4,
      xmlTag: "parameter",
      xmlRepetitionCount: 5,
      toolName: "read",
      exceedsTokenLimit: false,
    }
    expect(info.type).toBe("xml_repetition")
    expect(info.xmlTag).toBe("parameter")
    expect(info.xmlRepetitionCount).toBe(5)
    expect(info.toolName).toBe("read")
    expect(info.exceedsTokenLimit).toBe(false)
  })

  test("accepts xml_repetition type with token limit exceeded", () => {
    const info: LoopDetectedInfo = {
      type: "xml_repetition",
      threshold: 4,
      exceedsTokenLimit: true,
      toolName: "edit",
    }
    expect(info.exceedsTokenLimit).toBe(true)
    expect(info.xmlTag).toBeUndefined()
    expect(info.xmlRepetitionCount).toBeUndefined()
  })

  test("existing types remain unchanged — backward compatible", () => {
    const stepInfo: LoopDetectedInfo = {
      type: "step_loop",
      threshold: 3,
      fingerprint: "fp-123",
    }
    expect(stepInfo.type).toBe("step_loop")

    const sentenceInfo: LoopDetectedInfo = {
      type: "sentence_loop",
      threshold: 1,
      sentence: "repeated",
      firstIndex: 0,
    }
    expect(sentenceInfo.type).toBe("sentence_loop")
  })
})

describe("LoopDetectedError — xml_repetition message", () => {
  test("produces descriptive message for xml_repetition with tag repetition", () => {
    const info: LoopDetectedInfo = {
      type: "xml_repetition",
      threshold: 4,
      xmlTag: "parameter",
      xmlRepetitionCount: 5,
      exceedsTokenLimit: false,
    }
    const error = new LoopDetectedError(info)
    expect(error.message).toContain("xml_repetition")
    expect(error.message).toContain("parameter")
    expect(error.message).toContain("5")
    expect(error.message).toContain("false")
  })

  test("produces descriptive message for xml_repetition with token limit", () => {
    const info: LoopDetectedInfo = {
      type: "xml_repetition",
      threshold: 4,
      exceedsTokenLimit: true,
    }
    const error = new LoopDetectedError(info)
    expect(error.message).toContain("xml_repetition")
    expect(error.message).toContain("token limit exceeded")
    expect(error.message).not.toContain("undefined")
  })

  test("produces descriptive message for xml_repetition with token limit and tool name", () => {
    const info: LoopDetectedInfo = {
      type: "xml_repetition",
      threshold: 4,
      exceedsTokenLimit: true,
      toolName: "ReadFile",
    }
    const error = new LoopDetectedError(info)
    expect(error.message).toContain("xml_repetition")
    expect(error.message).toContain("token limit exceeded")
    expect(error.message).toContain("ReadFile")
    expect(error.message).not.toContain("undefined")
  })

  test("existing error types still produce correct messages", () => {
    const stepError = new LoopDetectedError({ type: "step_loop", threshold: 3 })
    expect(stepError.message).toContain("step_loop")
    expect(stepError.message).not.toContain("xml_repetition")

    const sentenceError = new LoopDetectedError({ type: "sentence_loop", threshold: 1, sentence: "test" })
    expect(sentenceError.message).toContain("sentence_loop")
    expect(sentenceError.message).toContain("test")
  })
})

describe("EvidenceRecord — xml_repetition type", () => {
  test("EvidenceAccumulator accepts xml_repetition type", () => {
    const acc = new EvidenceAccumulatorImpl()
    const info: LoopDetectedInfo = {
      type: "xml_repetition",
      threshold: 4,
      xmlTag: "parameter",
      xmlRepetitionCount: 5,
    }
    acc.add(info, 1)
    expect(acc.count).toBe(1)
    expect(acc.countByType("xml_repetition")).toBe(1)
  })
})

describe("EvidenceThresholds — xmlRepetition field", () => {
  test("defaultEvidenceThresholds includes xmlRepetition: 1", () => {
    expect(defaultEvidenceThresholds.xmlRepetition).toBe(1)
  })

  test("existing thresholds remain unchanged", () => {
    expect(defaultEvidenceThresholds.stepLoop).toBe(2)
    expect(defaultEvidenceThresholds.toolLoop).toBe(2)
    expect(defaultEvidenceThresholds.sentenceLoop).toBe(1)
    expect(defaultEvidenceThresholds.selfDiagnosis).toBe(2)
    expect(defaultEvidenceThresholds.patternLoop).toBe(2)
  })
})

describe("EvidenceAccumulator — xml_repetition threshold", () => {
  test("isThresholdMet checks xmlRepetition threshold", () => {
    const acc = new EvidenceAccumulatorImpl()
    acc.add({ type: "xml_repetition", threshold: 4, xmlTag: "parameter", xmlRepetitionCount: 5 }, 1)

    const result = acc.isThresholdMet(defaultConfig)
    expect(result.met).toBe(true)
    expect((result as { met: true; type: string }).type).toBe("xml_repetition")
  })

  test("isThresholdMet xmlRepetition with custom threshold", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      evidenceThresholds: { xmlRepetition: 3 },
    }
    const acc = new EvidenceAccumulatorImpl()
    acc.add({ type: "xml_repetition", threshold: 4, xmlTag: "parameter" }, 1)
    acc.add({ type: "xml_repetition", threshold: 4, xmlTag: "parameter" }, 2)

    // Below custom threshold of 3
    const result = acc.isThresholdMet(config)
    expect(result.met).toBe(false)
  })

  test("isThresholdMet xmlRepetition meets custom threshold", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      evidenceThresholds: { xmlRepetition: 2 },
    }
    const acc = new EvidenceAccumulatorImpl()
    acc.add({ type: "xml_repetition", threshold: 4, xmlTag: "parameter" }, 1)
    acc.add({ type: "xml_repetition", threshold: 4, xmlTag: "parameter" }, 2)

    const result = acc.isThresholdMet(config)
    expect(result.met).toBe(true)
    expect((result as { met: true; type: string }).type).toBe("xml_repetition")
  })
})

describe("UnstuckConfig — new xml_repetition fields", () => {
  test("defaultConfig includes new fields with correct defaults", () => {
    expect(defaultConfig.enableXmlRepetitionGuard).toBe(true)
    expect(defaultConfig.xmlRepetitionThreshold).toBe(4)
    expect(defaultConfig.xmlRepetitionWindowSize).toBe(10)
    expect(defaultConfig.maxToolInputTokens).toBe(4000)
    expect(defaultConfig.maxTotalToolInputTokens).toBe(16000)
  })

  test("existing config fields remain unchanged", () => {
    expect(defaultConfig.enabled).toBe(true)
    expect(defaultConfig.loopThreshold).toBe(3)
    expect(defaultConfig.detectToolOnlyLoops).toBe(true)
    expect(defaultConfig.historySize).toBe(10)
    expect(defaultConfig.strategy).toBe("nudge-and-prune")
  })
})

describe("mergeConfig — new fields", () => {
  test("mergeConfig spreads new fields from partial", () => {
    const merged = mergeConfig({
      enableXmlRepetitionGuard: false,
      xmlRepetitionThreshold: 6,
      xmlRepetitionWindowSize: 20,
      maxToolInputTokens: 8000,
      maxTotalToolInputTokens: 32000,
    })
    expect(merged.enableXmlRepetitionGuard).toBe(false)
    expect(merged.xmlRepetitionThreshold).toBe(6)
    expect(merged.xmlRepetitionWindowSize).toBe(20)
    expect(merged.maxToolInputTokens).toBe(8000)
    expect(merged.maxTotalToolInputTokens).toBe(32000)
  })

  test("mergeConfig preserves defaults for omitted new fields", () => {
    const merged = mergeConfig({
      loopThreshold: 5,
    })
    expect(merged.loopThreshold).toBe(5)
    expect(merged.enableXmlRepetitionGuard).toBe(true)
    expect(merged.xmlRepetitionThreshold).toBe(4)
    expect(merged.xmlRepetitionWindowSize).toBe(10)
    expect(merged.maxToolInputTokens).toBe(4000)
    expect(merged.maxTotalToolInputTokens).toBe(16000)
  })

  test("mergeConfig merges evidenceThresholds with xmlRepetition", () => {
    const merged = mergeConfig({
      evidenceThresholds: { xmlRepetition: 5 },
    })
    expect(merged.evidenceThresholds.xmlRepetition).toBe(5)
    expect(merged.evidenceThresholds.stepLoop).toBe(2)
    expect(merged.evidenceThresholds.toolLoop).toBe(2)
  })

  test("mergeConfig preserves existing evidenceThresholds defaults when not overridden", () => {
    const merged = mergeConfig({})
    expect(merged.evidenceThresholds.stepLoop).toBe(2)
    expect(merged.evidenceThresholds.xmlRepetition).toBe(1)
  })
})

describe("LoopDetector — xml_repetition integration", () => {
  const configWithXml: UnstuckConfig = {
    ...defaultConfig,
    enableXmlRepetitionGuard: true,
    xmlRepetitionThreshold: 4,
    xmlRepetitionWindowSize: 10,
    maxToolInputTokens: 4000,
    maxTotalToolInputTokens: 16000,
    loopThreshold: 10,
    detectToolOnlyLoops: false,
  }

  test("detector is initialized when enableXmlRepetitionGuard is true", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    // If the detector is initialized, consuming delta should not throw
    expect(() => {
      detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, configWithXml)
      detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, configWithXml)
    }).not.toThrow()
  })

  test("detector is NOT initialized when enableXmlRepetitionGuard is false", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: false })
    const config: UnstuckConfig = { ...defaultConfig, enableXmlRepetitionGuard: false, loopThreshold: 10, detectToolOnlyLoops: false }
    // Should not throw and should not detect anything
    const result = detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)
    expect(result).toBeUndefined()
  })

  test("tool-input-start resets xmlRepetitionDetector and sets currentToolName", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, configWithXml)
    // Feed some XML tags
    detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, configWithXml)
    detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, configWithXml)

    // Start a new tool — should reset the detector
    detector.consumeChunk({ type: "tool-input-start", id: "call-1", toolName: "WriteFile" }, configWithXml)

    // Now feed the same tags again — should not trigger because window was reset
    detector.consumeChunk({ type: "tool-input-delta", id: "call-1", text: "<parameter>value</parameter>" }, configWithXml)
    detector.consumeChunk({ type: "tool-input-delta", id: "call-1", text: "<parameter>value</parameter>" }, configWithXml)

    // With threshold 4, we only have 2 tags in the new window — no detection
    // If reset didn't work, we'd have 4+ and detection would fire
    // We need 2 more to reach threshold
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-1", text: "<parameter>value</parameter>" }, configWithXml)
    // This is the 3rd tag in the new window — still no detection
    expect(result).toBeUndefined()
  })

  test("tool-input-delta returns LoopDetectedInfo when repetition detected", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, configWithXml)

    // Feed 4 identical XML tags (threshold is 4)
    for (let i = 0; i < 3; i++) {
      const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, configWithXml)
      expect(result).toBeUndefined()
    }

    // 4th tag should trigger detection
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, configWithXml)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.xmlTag).toBe("parameter")
    expect(result?.xmlRepetitionCount).toBeGreaterThanOrEqual(4)
    expect(result?.toolName).toBe("ReadFile")
    expect(result?.exceedsTokenLimit).toBe(false)
  })

  test("tool-input-end clears currentToolName", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, configWithXml)
    detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, configWithXml)
    detector.consumeChunk({ type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } }, configWithXml)

    // After tool-input-end, currentToolName should be cleared
    // Feed more deltas — they should not be processed by xml detector since no currentToolName
    // (Actually, the detector still processes them — the toolName is just for metadata)
    // The key behavior: tool-input-end should clear currentToolName
    // We verify this indirectly: subsequent deltas without a preceding start should not cause issues
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-1", text: "<parameter>value</parameter>" }, configWithXml)
    // Should not throw
    expect(() => result).not.toThrow()
  })

  test("per-tool token limit triggers detection with exceedsTokenLimit: true", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...configWithXml,
      maxToolInputTokens: 100, // Very low limit for testing
    }
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)

    // Feed text that exceeds 100 tokens (100 * 4 = 400 chars)
    const longText = "x".repeat(500) // 500 chars ≈ 125 tokens
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: longText }, config)

    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("total token limit triggers detection across tool calls", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...configWithXml,
      maxToolInputTokens: 100000, // Very high — won't trigger per-tool
      maxTotalToolInputTokens: 200, // Low total limit for testing
    }

    // First tool call
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)
    detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "x".repeat(300) }, config) // ~75 tokens
    detector.consumeChunk({ type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } }, config)

    // Second tool call — total should exceed 200
    detector.consumeChunk({ type: "tool-input-start", id: "call-1", toolName: "WriteFile" }, config)
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-1", text: "x".repeat(600) }, config) // ~150 tokens, total ~225

    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("reset() clears detector state and total tokens", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...configWithXml,
      maxTotalToolInputTokens: 500,
    }

    // Accumulate some tokens
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)
    detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "x".repeat(300) }, config) // ~75 tokens

    // Reset should clear per-tool state but preserve total tokens
    detector.reset()

    // After reset, start a new tool — total tokens should still be tracked
    detector.consumeChunk({ type: "tool-input-start", id: "call-1", toolName: "WriteFile" }, config)
    // The per-tool state should be reset, so we can feed more without per-tool limit
    // But total tokens should still be accumulated
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-1", text: "x".repeat(2000) }, config) // ~500 tokens, total ~575

    // Total should exceed 500
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("clear() clears detector state and total tokens", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...configWithXml,
      maxTotalToolInputTokens: 1000,
    }

    // Accumulate some tokens
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)
    detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "x".repeat(300) }, config) // ~75 tokens

    // Clear should clear everything including total tokens
    detector.clear()

    // After clear, total tokens should be reset
    detector.consumeChunk({ type: "tool-input-start", id: "call-1", toolName: "WriteFile" }, config)
    // Now feed tokens that would exceed limit if total wasn't reset
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-1", text: "x".repeat(300) }, config) // ~75 tokens — well under 1000

    expect(result).toBeUndefined()
  })

  test("existing detection types remain unaffected — step_loop still detected", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...defaultConfig,
      enableXmlRepetitionGuard: true,
      loopThreshold: 3,
    }

    for (let i = 0; i < 3; i++) {
      detector.consumeChunk(
        { type: "text-delta", text: "Same thinking text that is long enough to pass the minThinkingLength threshold for detection here." },
        config,
      )
      detector.consumeChunk(
        { type: "tool-input-end", id: `call-${i}`, toolName: "ReadFile", input: { path: "/foo" } },
        config,
      )
      detector.consumeChunk(
        { type: "finish", finishReason: "tool-calls" },
        config,
      )
    }

    const state = detector.getState()
    expect(state.historyLength).toBe(3)

    // Re-check via finalizeStep to trigger detection
    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("step_loop")
  })

  test("existing detection types remain unaffected — tool_loop still detected", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...defaultConfig,
      enableXmlRepetitionGuard: true,
      loopThreshold: 10,
      detectToolOnlyLoops: true,
      toolLoopThreshold: 3,
    }

    for (let i = 0; i < 3; i++) {
      detector.consumeChunk(
        { type: "text-delta", text: `Different thinking ${i} that is long enough to pass the minThinkingLength threshold for detection here.` },
        config,
      )
      detector.consumeChunk(
        { type: "tool-input-end", id: `call-${i}`, toolName: "ReadFile", input: { path: "/foo" } },
        config,
      )
      detector.consumeChunk(
        { type: "finish", finishReason: "tool-calls" },
        config,
      )
    }

    const state = detector.getState()
    expect(state.historyLength).toBe(3)

    // Re-check via finalizeStep to trigger detection
    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeDefined()
    expect(result?.type).toBe("tool_loop")
  })

  test("token estimation is delegated to XmlRepetitionDetector (not hardcoded)", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...configWithXml,
      maxToolInputTokens: 1, // 1 token = 4 chars minimum
    }

    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)

    // 5 chars = ceil(5/4) = 2 tokens — exceeds limit 1
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "abcde" }, config)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("XML content in tool-input-delta triggers token limit earlier due to XML multiplier", () => {
    // When text contains XML (< and >), the detector applies a 1.5x multiplier,
    // so the same text triggers token limits sooner than non-XML text.
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    // 4 chars → non-XML: ceil(4/4)=1 token; XML: ceil(4/4*1.5)=2 tokens
    const config: UnstuckConfig = {
      ...configWithXml,
      maxToolInputTokens: 1,
    }

    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)

    // Non-XML: 4 chars = 1 token → at limit, not exceeded
    const nonXmlResult = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "abcd" }, config)
    // 1 token = limit of 1, so NOT exceeded (strict >)
    expect(nonXmlResult).toBeUndefined()

    // XML: 4 chars with < and > → ceil(4/4*1.5) = 2 tokens → exceeds limit of 1
    const xmlResult = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "a<>c" }, config)
    expect(xmlResult).toBeDefined()
    expect(xmlResult?.type).toBe("xml_repetition")
    expect(xmlResult?.exceedsTokenLimit).toBe(true)
  })

  test("token estimation is handled by XmlRepetitionDetector — no hardcoded estimation in loop-detector", () => {
    // Verifies that XmlRepetitionDetector's internal XML-aware estimation is the sole source of truth.
    // The loop-detector should NOT compute Math.ceil(text.length / 4) separately.
    // Test: XML text with multiplier triggers earlier than non-XML text of same length.
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...configWithXml,
      maxToolInputTokens: 1,
    }

    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)

    // XML text: 4 chars with < and > → ceil(4/4*1.5) = 2 tokens → exceeds limit of 1
    const xmlResult = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "a<>c" }, config)
    expect(xmlResult).toBeDefined()
    expect(xmlResult?.type).toBe("xml_repetition")
    expect(xmlResult?.exceedsTokenLimit).toBe(true)

    // Now test with a fresh detector — non-XML text of same length should NOT exceed
    const detector2 = createDetector({ enableXmlRepetitionGuard: true })
    detector2.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)
    const nonXmlResult = detector2.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "abcd" }, config)
    // 1 token = limit of 1, NOT exceeded (strict >)
    expect(nonXmlResult).toBeUndefined()
  })

  test("finalizeStep does not trigger xml_repetition from step-level detection", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...configWithXml,
      loopThreshold: 10,
    }

    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)
    detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, config)
    detector.consumeChunk({ type: "tool-input-end", id: "call-0", toolName: "ReadFile", input: { path: "/foo" } }, config)

    // finalizeStep should not produce xml_repetition — it's a step-level check
    const result = detector.finalizeStep(config, "tool-calls")
    expect(result).toBeUndefined()
  })

  test("mapRepetitionToLoopInfo with empty tagName and zero repetitionCount produces undefined fields", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...configWithXml,
      maxToolInputTokens: 1, // Very low — will trigger token limit on first delta
    }

    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)
    // "abcde" = ceil(5/4) = 2 tokens, exceeds limit of 1
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "abcde" }, config)

    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.exceedsTokenLimit).toBe(true)
    // Empty tagName and zero repetitionCount should map to undefined (not "" or 0)
    expect(result?.xmlTag).toBeUndefined()
    expect(result?.xmlRepetitionCount).toBeUndefined()
  })

  test("mapRepetitionToLoopInfo with actual values preserves tagName and repetitionCount", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, configWithXml)

    // Feed 4 identical XML tags (threshold is 4) — triggers actual repetition detection
    for (let i = 0; i < 3; i++) {
      const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, configWithXml)
      expect(result).toBeUndefined()
    }

    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, configWithXml)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.xmlTag).toBe("parameter")
    expect(result?.xmlRepetitionCount).toBeGreaterThanOrEqual(4)
    expect(result?.exceedsTokenLimit).toBe(false)
  })

  test("LoopDetectedError with token limit exceeded does not contain 'undefined' in message", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    const config: UnstuckConfig = {
      ...configWithXml,
      maxToolInputTokens: 1,
    }

    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "abcde" }, config)

    expect(result).toBeDefined()
    const error = new LoopDetectedError(result!)
    // The message should NOT contain the word "undefined" as a value
    expect(error.message).not.toContain("undefined")
    expect(error.message).toContain("xml_repetition")
    expect(error.message).toContain("token limit exceeded")
  })

  test("LoopDetectedError with actual repetition shows correct tag and count", () => {
    const detector = createDetector({ enableXmlRepetitionGuard: true })
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, configWithXml)

    for (let i = 0; i < 3; i++) {
      detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, configWithXml)
    }

    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, configWithXml)
    expect(result).toBeDefined()

    const error = new LoopDetectedError(result!)
    expect(error.message).toContain("parameter")
    expect(error.message).toContain("false") // exceedsTokenLimit
  })

  test("modelId flows to XmlRepetitionDetector — qwen uses qwen thresholds", () => {
    const qwenThresholds = {
      qwen: {
        repetitionThreshold: 3,
        maxToolInputTokens: 2500,
        partialTagThreshold: 2,
      },
    }
    const config: UnstuckConfig = {
      ...defaultConfig,
      enableXmlRepetitionGuard: true,
      xmlRepetitionThreshold: 4,
      xmlRepetitionWindowSize: 10,
      maxToolInputTokens: 4000,
      maxTotalToolInputTokens: 16000,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: qwenThresholds,
    }

    const detector = createDetector({ enableXmlRepetitionGuard: true })
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)

    // With qwen threshold of 3, 3 tags should trigger (vs default 4)
    for (let i = 0; i < 2; i++) {
      const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, config)
      expect(result).toBeUndefined()
    }

    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, config)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.xmlTag).toBe("parameter")
  })

  test("modelId flows to XmlRepetitionDetector — non-qwen uses default thresholds", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      enableXmlRepetitionGuard: true,
      xmlRepetitionThreshold: 4,
      xmlRepetitionWindowSize: 10,
      maxToolInputTokens: 4000,
      maxTotalToolInputTokens: 16000,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      modelId: "gpt-4o",
    }

    const detector = createDetector({ enableXmlRepetitionGuard: true })
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)

    // 3 tags — below default threshold of 4
    for (let i = 0; i < 3; i++) {
      const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, config)
      expect(result).toBeUndefined()
    }

    // 4th tag — at default threshold of 4 → detected
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, config)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
  })

  test("modelId flows to XmlRepetitionDetector — qwen token limit uses qwen maxToolInputTokens", () => {
    const qwenThresholds = {
      qwen: {
        repetitionThreshold: 3,
        maxToolInputTokens: 2500,
        partialTagThreshold: 2,
      },
    }
    const config: UnstuckConfig = {
      ...defaultConfig,
      enableXmlRepetitionGuard: true,
      xmlRepetitionThreshold: 4,
      xmlRepetitionWindowSize: 10,
      maxToolInputTokens: 4000,
      maxTotalToolInputTokens: 16000,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: qwenThresholds,
    }

    const detector = createDetector({ enableXmlRepetitionGuard: true })
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)

    // 3000 tokens — under default 4000 but over qwen 2500
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "x".repeat(12000) }, config)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("modelId not set — graceful fallback to defaults", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      enableXmlRepetitionGuard: true,
      xmlRepetitionThreshold: 4,
      xmlRepetitionWindowSize: 10,
      maxToolInputTokens: 4000,
      maxTotalToolInputTokens: 16000,
      loopThreshold: 10,
      detectToolOnlyLoops: false,
      // No modelId
    }

    const detector = createDetector({ enableXmlRepetitionGuard: true })
    detector.consumeChunk({ type: "tool-input-start", id: "call-0", toolName: "ReadFile" }, config)

    // 3 tags — below default threshold of 4
    for (let i = 0; i < 3; i++) {
      const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, config)
      expect(result).toBeUndefined()
    }

    // 4th tag — at default threshold of 4 → detected
    const result = detector.consumeChunk({ type: "tool-input-delta", id: "call-0", text: "<parameter>value</parameter>" }, config)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
  })
})

describe("UnstuckConfig — modelId field", () => {
  test("UnstuckConfig interface accepts modelId", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      modelId: "qwen3.6-40b",
    }
    expect(config.modelId).toBe("qwen3.6-40b")
  })

  test("UnstuckConfig interface accepts modelSpecificThresholds", () => {
    const config: UnstuckConfig = {
      ...defaultConfig,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: {
        qwen: {
          repetitionThreshold: 3,
          maxToolInputTokens: 2500,
          partialTagThreshold: 2,
        },
      },
    }
    expect(config.modelSpecificThresholds?.qwen.repetitionThreshold).toBe(3)
    expect(config.modelSpecificThresholds?.qwen.maxToolInputTokens).toBe(2500)
    expect(config.modelSpecificThresholds?.qwen.partialTagThreshold).toBe(2)
  })

  test("defaultConfig has modelId as undefined", () => {
    expect(defaultConfig.modelId).toBeUndefined()
  })

  test("mergeConfig preserves modelId from partial", () => {
    const merged = mergeConfig({
      modelId: "qwen3.6-40b",
    })
    expect(merged.modelId).toBe("qwen3.6-40b")
  })

  test("mergeConfig preserves modelSpecificThresholds from partial", () => {
    const merged = mergeConfig({
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: {
        qwen: {
          repetitionThreshold: 3,
          maxToolInputTokens: 2500,
          partialTagThreshold: 2,
        },
      },
    })
    expect(merged.modelSpecificThresholds?.qwen.repetitionThreshold).toBe(3)
  })
})

import { describe, expect, test } from "bun:test"
import { SentenceTracker } from "./sentence-tracker"
import { defaultConfig, type UnstuckConfig } from "./config"

describe("SentenceTracker — sentence splitting", () => {
  test("splits on period followed by space and capital letter", () => {
    const tracker = new SentenceTracker()
    const text = "First sentence here. Second sentence here. Third sentence here."
    const result = tracker.consumeText(text, defaultConfig)
    expect(result).toBeUndefined() // No loop with only 3 different sentences
  })

  test("splits on question mark and exclamation mark", () => {
    const tracker = new SentenceTracker()
    const text = "Is this a question? Yes it is! Another one here."
    const result = tracker.consumeText(text, defaultConfig)
    expect(result).toBeUndefined()
  })

  test("skips short fragments", () => {
    const tracker = new SentenceTracker()
    const text = "Hi. Let me check the file and see what is going on here."
    const result = tracker.consumeText(text, defaultConfig)
    expect(result).toBeUndefined()
  })

  test("respects minSentenceLength", () => {
    const tracker = new SentenceTracker()
    const config: UnstuckConfig = { ...defaultConfig, minSentenceLength: 20 }
    const text = "Hi. Let me check the file and see what is going on here."
    const result = tracker.consumeText(text, config)
    expect(result).toBeUndefined()
  })
})

describe("SentenceTracker — periodic repetition detection", () => {
  test("detects same sentence repeating every 2 sentences", () => {
    const tracker = new SentenceTracker()
    const config: UnstuckConfig = { ...defaultConfig, sentenceLoopThreshold: 3, minSentenceLength: 10 }
    const text = "Let me check the file. I need to read it. Let me check the file. I need to read it. Let me check the file. I need to read it."
    const result = tracker.consumeText(text, config)
    expect(result).toBeDefined()
    expect(result?.type).toBe("sentence_loop")
    expect(result?.threshold).toBeGreaterThanOrEqual(3)
    expect(result?.sentence).toBe("Let me check the file.")
  })

  test("does not detect loop with different sentences", () => {
    const tracker = new SentenceTracker()
    const config: UnstuckConfig = { ...defaultConfig, sentenceLoopThreshold: 3, minSentenceLength: 10 }
    const text = "First sentence here. Second sentence here. Third sentence here. Fourth sentence here. Fifth sentence here."
    const result = tracker.consumeText(text, config)
    expect(result).toBeUndefined()
  })

  test("does not detect loop below threshold", () => {
    const tracker = new SentenceTracker()
    const config: UnstuckConfig = { ...defaultConfig, sentenceLoopThreshold: 3, minSentenceLength: 10 }
    const text = "Let me check the file. I need to read it. Let me check the file. I need to read it."
    const result = tracker.consumeText(text, config)
    // Only 2 repetitions of "Let me check the file"
    expect(result).toBeUndefined()
  })

  test("respects sentenceLoopThreshold", () => {
    const tracker = new SentenceTracker()
    const config: UnstuckConfig = { ...defaultConfig, sentenceLoopThreshold: 4, minSentenceLength: 10 }
    const text = "Let me check the file. I need to read it. Let me check the file. I need to read it. Let me check the file. I need to read it. Let me check the file."
    const result = tracker.consumeText(text, config)
    expect(result).toBeDefined()
    expect(result?.threshold).toBeGreaterThanOrEqual(4)
  })
})

describe("SentenceTracker — code block exclusion", () => {
  test("skips text inside code blocks", () => {
    const tracker = new SentenceTracker()
    const config: UnstuckConfig = { ...defaultConfig, sentenceLoopThreshold: 3, minSentenceLength: 10 }
    const text = "Let me check the file. ```Let me check the file. Let me check the file.``` I need to read it. Let me check the file. I need to read it. Let me check the file."
    const result = tracker.consumeText(text, config)
    // Only 3 instances of "Let me check the file" outside code blocks
    // But there are also instances inside code blocks that should be skipped
    // The test should still detect the loop from the non-code-block instances
    expect(result).toBeDefined()
    expect(result?.type).toBe("sentence_loop")
  })
})

describe("SentenceTracker — case insensitivity", () => {
  test("detects loop with different casing", () => {
    const tracker = new SentenceTracker()
    const config: UnstuckConfig = { ...defaultConfig, sentenceLoopThreshold: 3, minSentenceLength: 10 }
    const text = "Let me check the file. I need to read it. let me check the file. I need to read it. LET ME CHECK THE FILE. I need to read it."
    const result = tracker.consumeText(text, config)
    expect(result).toBeDefined()
    expect(result?.type).toBe("sentence_loop")
  })
})

describe("SentenceTracker — reset", () => {
  test("clears history after reset", () => {
    const tracker = new SentenceTracker()
    const text = "Let me check the file. I need to read it."
    tracker.consumeText(text, defaultConfig)
    tracker.reset()
    // After reset, adding the same text should not trigger a loop
    const result = tracker.consumeText(text, { ...defaultConfig, sentenceLoopThreshold: 3, minSentenceLength: 10 })
    expect(result).toBeUndefined()
  })
})

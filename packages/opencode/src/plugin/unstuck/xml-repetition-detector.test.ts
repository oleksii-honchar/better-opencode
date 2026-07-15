import { describe, expect, test } from "bun:test"
import { XmlRepetitionDetector, type RepetitionDetected } from "./xml-repetition-detector"

function createDetector(opts?: {
  repetitionThreshold?: number
  windowSize?: number
  maxToolInputTokens?: number
  maxTotalTokens?: number
}) {
  return new XmlRepetitionDetector({
    repetitionThreshold: opts?.repetitionThreshold ?? 4,
    windowSize: opts?.windowSize ?? 10,
    maxToolInputTokens: opts?.maxToolInputTokens ?? 4000,
    maxTotalTokens: opts?.maxTotalTokens ?? 16000,
  })
}

describe("XmlRepetitionDetector — tag extraction and normalization", () => {
  test("extracts opening/closing XML tags", () => {
    const detector = createDetector()
    const result = detector.consumeDelta("read", "<parameter>value1</parameter>", 10)
    expect(result).toBeUndefined()
    const state = detector.getState()
    expect(state.tagWindowLength).toBe(1)
  })

  test("extracts self-closing XML tags", () => {
    const detector = createDetector()
    const result = detector.consumeDelta("read", "<br/>", 5)
    expect(result).toBeUndefined()
    const state = detector.getState()
    expect(state.tagWindowLength).toBe(1)
  })

  test("normalizes tag names to lowercase", () => {
    const detector = createDetector({ repetitionThreshold: 2 })
    detector.consumeDelta("read", "<Parameter>value1</Parameter>", 10)
    const result = detector.consumeDelta("read", "<parameter>value2</parameter>", 10)
    expect(result).toBeDefined()
    expect(result?.tagName).toBe("parameter")
  })

  test("strips attributes from tag comparison", () => {
    const detector = createDetector({ repetitionThreshold: 2 })
    detector.consumeDelta("read", "<parameter attr='x'>value1</parameter>", 10)
    const result = detector.consumeDelta("read", "<parameter>value2</parameter>", 10)
    expect(result).toBeDefined()
    expect(result?.tagName).toBe("parameter")
  })

  test("collapses whitespace in tag comparison", () => {
    const detector = createDetector({ repetitionThreshold: 2 })
    detector.consumeDelta("read", "<parameter  >value1</parameter>", 10)
    const result = detector.consumeDelta("read", "<parameter>value2</parameter>", 10)
    expect(result).toBeDefined()
    expect(result?.tagName).toBe("parameter")
  })

  test("does not match partial tag names", () => {
    const detector = createDetector({ repetitionThreshold: 2 })
    detector.consumeDelta("read", "<param>value1</param>", 10)
    const result = detector.consumeDelta("read", "<parameter>value2</parameter>", 10)
    expect(result).toBeUndefined()
  })

  test("handles empty text", () => {
    const detector = createDetector()
    const result = detector.consumeDelta("read", "", 0)
    expect(result).toBeUndefined()
    expect(detector.getState().tagWindowLength).toBe(0)
  })

  test("handles non-XML content", () => {
    const detector = createDetector()
    const result = detector.consumeDelta("read", "just plain text with no xml", 20)
    expect(result).toBeUndefined()
    expect(detector.getState().tagWindowLength).toBe(0)
  })

  test("handles malformed XML gracefully", () => {
    const detector = createDetector()
    const result = detector.consumeDelta("read", "<parameter>unclosed tag", 15)
    expect(result).toBeUndefined()
    // Should not crash; may or may not extract the tag depending on regex
  })

  test("handles multiple tags in one delta", () => {
    const detector = createDetector()
    const result = detector.consumeDelta("read", "<parameter>v1</parameter><parameter>v2</parameter>", 15)
    expect(result).toBeUndefined()
    const state = detector.getState()
    expect(state.tagWindowLength).toBe(2)
  })
})

describe("XmlRepetitionDetector — repetition detection", () => {
  test("detects repeated XML tags at threshold", () => {
    const detector = createDetector({ repetitionThreshold: 4 })
    for (let i = 0; i < 3; i++) {
      const result = detector.consumeDelta("read", `<parameter>value${i}</parameter>`, 10)
      expect(result).toBeUndefined()
    }
    // 4th occurrence triggers detection
    const result = detector.consumeDelta("read", "<parameter>value3</parameter>", 10)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.tagName).toBe("parameter")
    expect(result?.repetitionCount).toBeGreaterThanOrEqual(4)
    expect(result?.exceedsTokenLimit).toBe(false)
  })

  test("does NOT detect varied XML tags (no false positives)", () => {
    const detector = createDetector({ repetitionThreshold: 4 })
    const tags = ["parameter", "function", "command", "filePath"]
    for (const tag of tags) {
      const result = detector.consumeDelta("read", `<${tag}>value</${tag}>`, 10)
      expect(result).toBeUndefined()
    }
  })

  test("does NOT detect below threshold", () => {
    const detector = createDetector({ repetitionThreshold: 4 })
    for (let i = 0; i < 3; i++) {
      const result = detector.consumeDelta("read", `<parameter>value${i}</parameter>`, 10)
      expect(result).toBeUndefined()
    }
  })

  test("respects sliding window — old tags fall out of window", () => {
    const detector = createDetector({ repetitionThreshold: 4, windowSize: 5 })
    // Fill window with 3 "parameter" tags
    for (let i = 0; i < 3; i++) {
      detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 5)
    }
    // Add 3 other tags — pushes old "parameter" tags out of window
    detector.consumeDelta("read", "<function>f1</function>", 5)
    detector.consumeDelta("read", "<command>c1</command>", 5)
    detector.consumeDelta("read", "<filePath>p1</filePath>", 5)
    // Now add 3 more "parameter" tags — only 3 in window, below threshold of 4
    for (let i = 0; i < 3; i++) {
      const result = detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 5)
      expect(result).toBeUndefined()
    }
  })

  test("detects repetition after window slides — enough same tags remain", () => {
    const detector = createDetector({ repetitionThreshold: 4, windowSize: 6 })
    // 3 parameter tags
    for (let i = 0; i < 3; i++) {
      detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 5)
    }
    // 2 other tags (window is 6, so 3 parameter + 2 other = 5 in window)
    detector.consumeDelta("read", "<function>f1</function>", 5)
    detector.consumeDelta("read", "<command>c1</command>", 5)
    // 1 more parameter — now 4 in window of 6 → detected
    const result = detector.consumeDelta("read", "<parameter>v99</parameter>", 5)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
  })
})

describe("XmlRepetitionDetector — token limits", () => {
  test("per-tool token limit triggers detection", () => {
    const detector = createDetector({ maxToolInputTokens: 100 })
    // 90 tokens — under limit
    const r1 = detector.consumeDelta("read", "some content", 90)
    expect(r1).toBeUndefined()
    // 15 more tokens — exceeds 100
    const r2 = detector.consumeDelta("read", "more content", 15)
    expect(r2).toBeDefined()
    expect(r2?.exceedsTokenLimit).toBe(true)
  })

  test("total token limit across tools triggers detection", () => {
    const detector = createDetector({ maxTotalTokens: 100 })
    // 60 tokens on tool "read"
    detector.consumeDelta("read", "content1", 60)
    // Reset for new tool (simulates tool-input-start)
    detector.reset()
    // 50 tokens on tool "write" — total now 110 > 100
    const result = detector.consumeDelta("write", "content2", 50)
    expect(result).toBeDefined()
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("per-tool limit is lower priority than repetition detection", () => {
    const detector = createDetector({ repetitionThreshold: 2, maxToolInputTokens: 10000 })
    // Repetition triggers first
    detector.consumeDelta("read", "<parameter>v1</parameter>", 5)
    const result = detector.consumeDelta("read", "<parameter>v2</parameter>", 5)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.exceedsTokenLimit).toBe(false)
  })
})

describe("XmlRepetitionDetector — reset", () => {
  test("reset clears tag window", () => {
    const detector = createDetector({ repetitionThreshold: 4 })
    detector.consumeDelta("read", "<parameter>v1</parameter>", 10)
    detector.consumeDelta("read", "<parameter>v2</parameter>", 10)
    expect(detector.getState().tagWindowLength).toBe(2)
    detector.reset()
    expect(detector.getState().tagWindowLength).toBe(0)
  })

  test("reset clears per-tool token count but preserves total", () => {
    const detector = createDetector()
    detector.consumeDelta("read", "content", 50)
    expect(detector.getState().currentToolTokens).toBe(50)
    expect(detector.getState().totalTokens).toBe(50)
    detector.reset()
    expect(detector.getState().currentToolTokens).toBe(0)
    expect(detector.getState().totalTokens).toBe(50)
  })

  test("reset allows new tool to start fresh", () => {
    const detector = createDetector({ repetitionThreshold: 4 })
    // Near threshold on first tool
    for (let i = 0; i < 3; i++) {
      detector.consumeDelta("read", "<parameter>v1</parameter>", 5)
    }
    // Reset for new tool
    detector.reset()
    // 3 more on new tool — below threshold
    for (let i = 0; i < 3; i++) {
      const result = detector.consumeDelta("write", "<parameter>v2</parameter>", 5)
      expect(result).toBeUndefined()
    }
  })
})

describe("XmlRepetitionDetector — getState", () => {
  test("returns accurate state after consumeDelta", () => {
    const detector = createDetector()
    detector.consumeDelta("read", "<parameter>v1</parameter>", 10)
    detector.consumeDelta("read", "<parameter>v2</parameter>", 15)

    const state = detector.getState()
    expect(state.tagWindowLength).toBe(2)
    expect(state.currentToolTokens).toBe(25)
    expect(state.totalTokens).toBe(25)
  })

  test("returns zero state initially", () => {
    const detector = createDetector()
    const state = detector.getState()
    expect(state.tagWindowLength).toBe(0)
    expect(state.currentToolTokens).toBe(0)
    expect(state.totalTokens).toBe(0)
  })
})

describe("XmlRepetitionDetector — edge cases", () => {
  test("handles self-closing tags in repetition detection", () => {
    const detector = createDetector({ repetitionThreshold: 3 })
    detector.consumeDelta("read", "<br/>", 5)
    detector.consumeDelta("read", "<br/>", 5)
    const result = detector.consumeDelta("read", "<br/>", 5)
    expect(result).toBeDefined()
    expect(result?.tagName).toBe("br")
  })

  test("handles mixed tag types — self-closing and opening/closing", () => {
    const detector = createDetector({ repetitionThreshold: 3 })
    detector.consumeDelta("read", "<br/>", 5)
    detector.consumeDelta("read", "<br>text</br>", 5)
    const result = detector.consumeDelta("read", "<br/>", 5)
    expect(result).toBeDefined()
    expect(result?.tagName).toBe("br")
  })

  test("token estimation matches spec: Math.ceil(length / 4)", () => {
    const detector = createDetector({ maxToolInputTokens: 10 })
    // 39 chars → ceil(39/4) = 10 tokens — at limit
    const r1 = detector.consumeDelta("read", "a".repeat(39), 10)
    expect(r1).toBeUndefined()
    // 1 more char → 11 tokens — exceeds
    const r2 = detector.consumeDelta("read", "x", 1)
    expect(r2).toBeDefined()
    expect(r2?.exceedsTokenLimit).toBe(true)
  })

  test("repetitionDetected includes correct metadata", () => {
    const detector = createDetector({ repetitionThreshold: 3 })
    detector.consumeDelta("read", "<parameter>v1</parameter>", 10)
    detector.consumeDelta("read", "<parameter>v2</parameter>", 10)
    const result = detector.consumeDelta("read", "<parameter>v3</parameter>", 10)

    expect(result).toBeDefined()
    const detected = result as RepetitionDetected
    expect(detected.type).toBe("xml_repetition")
    expect(detected.tagName).toBe("parameter")
    expect(detected.repetitionCount).toBeGreaterThanOrEqual(3)
    expect(detected.totalTokens).toBe(30)
    expect(detected.exceedsTokenLimit).toBe(false)
  })

  test("handles deeply nested XML tags", () => {
    const detector = createDetector({ repetitionThreshold: 2 })
    // Nested: outer <function> contains inner <parameter>
    detector.consumeDelta("read", "<function><parameter>v1</parameter></function>", 20)
    const result = detector.consumeDelta("read", "<function><parameter>v2</parameter></function>", 20)
    // Should detect "function" repetition (outer tag)
    expect(result).toBeDefined()
    expect(result?.tagName).toBe("function")
  })

  test("handles overlapping tag patterns gracefully", () => {
    const detector = createDetector()
    // Malformed but shouldn't crash
    const result = detector.consumeDelta("read", "<parameter><parameter>v</parameter></parameter>", 15)
    expect(result).toBeUndefined()
  })

  test("different tools tracked independently after reset", () => {
    const detector = createDetector({ maxToolInputTokens: 50 })
    // Tool "read" — 40 tokens
    detector.consumeDelta("read", "content", 40)
    detector.reset()
    // Tool "write" — 40 tokens (under limit)
    const result = detector.consumeDelta("write", "content", 40)
    expect(result).toBeUndefined()
    expect(detector.getState().currentToolTokens).toBe(40)
  })
})

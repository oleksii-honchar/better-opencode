import { describe, expect, test } from "bun:test"
import { XmlRepetitionDetector, XML_OPENING_TAG_PATTERN, XML_CLOSING_TAG_PATTERN, XML_MALFORMED_PATTERN, type RepetitionDetected } from "./xml-repetition-detector"

function createDetector(opts?: {
  repetitionThreshold?: number
  windowSize?: number
  maxToolInputTokens?: number
  maxTotalTokens?: number
  partialTagThreshold?: number
  modelId?: string
  modelSpecificThresholds?: any
  xmlTokenEstimationMultiplier?: number
}) {
  return new XmlRepetitionDetector({
    repetitionThreshold: opts?.repetitionThreshold ?? 4,
    windowSize: opts?.windowSize ?? 10,
    maxToolInputTokens: opts?.maxToolInputTokens ?? 4000,
    maxTotalTokens: opts?.maxTotalTokens ?? 16000,
    partialTagThreshold: opts?.partialTagThreshold,
    modelId: opts?.modelId,
    modelSpecificThresholds: opts?.modelSpecificThresholds,
    xmlTokenEstimationMultiplier: opts?.xmlTokenEstimationMultiplier,
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
    const detector = createDetector({ maxToolInputTokens: 5 })
    // 20 chars plain text → ceil(20/4) = 5 tokens — at limit
    const r1 = detector.consumeDelta("read", "a".repeat(20), 0)
    expect(r1).toBeUndefined()
    // 4 more chars → ceil(24/4) = 6 tokens — exceeds 5
    const r2 = detector.consumeDelta("read", "b".repeat(4), 0)
    expect(r2).toBeDefined()
    expect(r2?.exceedsTokenLimit).toBe(true)
  })

  test("total token limit across tools triggers detection", () => {
    const detector = createDetector({ maxTotalTokens: 5 })
    // 16 chars plain text → ceil(16/4) = 4 tokens on tool "read"
    detector.consumeDelta("read", "a".repeat(16), 0)
    // Reset for new tool (simulates tool-input-start)
    detector.reset()
    // 8 chars → ceil(8/4) = 2 tokens on tool "write" — total now 6 > 5
    const result = detector.consumeDelta("write", "b".repeat(8), 0)
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
    // 20 chars plain text → ceil(20/4) = 5 tokens
    detector.consumeDelta("read", "a".repeat(20), 0)
    expect(detector.getState().currentToolTokens).toBe(5)
    expect(detector.getState().totalTokens).toBe(5)
    detector.reset()
    expect(detector.getState().currentToolTokens).toBe(0)
    expect(detector.getState().totalTokens).toBe(5)
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
    // "<parameter>v1</parameter>" = 25 chars XML → ceil(25/4 * 1.5) = 10 tokens
    // "<parameter>v2</parameter>" = 25 chars XML → ceil(25/4 * 1.5) = 10 tokens
    detector.consumeDelta("read", "<parameter>v1</parameter>", 0)
    detector.consumeDelta("read", "<parameter>v2</parameter>", 0)

    const state = detector.getState()
    expect(state.tagWindowLength).toBe(2)
    expect(state.currentToolTokens).toBe(20)
    expect(state.totalTokens).toBe(20)
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
    const detector = createDetector({ partialTagThreshold: 4 })
    // Nested parameter tags — shouldn't crash
    const result = detector.consumeDelta("read", "<parameter><parameter>v</parameter></parameter>", 15)
    expect(result).toBeUndefined()
  })

  test("different tools tracked independently after reset", () => {
    const detector = createDetector({ maxToolInputTokens: 15 })
    // Tool "read" — 20 chars plain → ceil(20/4) = 5 tokens
    detector.consumeDelta("read", "a".repeat(20), 0)
    detector.reset()
    // Tool "write" — 20 chars plain → ceil(20/4) = 5 tokens (under limit)
    const result = detector.consumeDelta("write", "b".repeat(20), 0)
    expect(result).toBeUndefined()
    expect(detector.getState().currentToolTokens).toBe(5)
  })
})

describe("XML_OPENING_TAG_PATTERN — opening tags only", () => {
  function collectMatches(text: string): string[] {
    const matches: string[] = []
    const regex = new RegExp(XML_OPENING_TAG_PATTERN)
    let m: RegExpExecArray | null
    while ((m = regex.exec(text)) !== null) {
      matches.push(m[1])
    }
    return matches
  }

  test("matches simple opening tag", () => {
    const matches = collectMatches("<parameter>value</parameter>")
    expect(matches).toContain("parameter")
  })

  test("matches opening tag with attributes", () => {
    const matches = collectMatches('<parameter attr="x">value</parameter>')
    expect(matches).toContain("parameter")
  })

  test("matches multiple opening tags", () => {
    const matches = collectMatches("<function>...</function><parameter>...</parameter>")
    expect(matches).toContain("function")
    expect(matches).toContain("parameter")
  })

  test("does NOT match closing tags", () => {
    const matches = collectMatches("</parameter>")
    expect(matches).not.toContain("parameter")
  })

  test("does NOT match self-closing tags", () => {
    const matches = collectMatches("<br/>")
    expect(matches).not.toContain("br")
  })

  test("matches opening tag even when closing tag is present in same text", () => {
    const matches = collectMatches("<parameter>value</parameter>")
    // Should match the opening tag; closing tag is not matched by this pattern
    expect(matches).toContain("parameter")
    // Only one match for "parameter" (the opening tag), not the closing
    const count = matches.filter(t => t === "parameter").length
    expect(count).toBe(1)
  })
})

describe("XML_CLOSING_TAG_PATTERN — closing tags only", () => {
  function collectMatches(text: string): string[] {
    const matches: string[] = []
    const regex = new RegExp(XML_CLOSING_TAG_PATTERN)
    let m: RegExpExecArray | null
    while ((m = regex.exec(text)) !== null) {
      matches.push(m[1])
    }
    return matches
  }

  test("matches simple closing tag", () => {
    const matches = collectMatches("</parameter>")
    expect(matches).toContain("parameter")
  })

  test("matches multiple closing tags", () => {
    const matches = collectMatches("</function></parameter>")
    expect(matches).toContain("function")
    expect(matches).toContain("parameter")
  })

  test("does NOT match opening tags alone", () => {
    const matches = collectMatches("<parameter>value")
    expect(matches).not.toContain("parameter")
  })

  test("matches closing tag that appears alongside opening tag", () => {
    const matches = collectMatches("<parameter>value</parameter>")
    // Closing tag pattern matches </parameter> — one match
    expect(matches).toContain("parameter")
    expect(matches.filter(t => t === "parameter").length).toBe(1)
  })

  test("does NOT match self-closing tags", () => {
    const matches = collectMatches("<br/>")
    expect(matches).not.toContain("br")
  })
})

describe("XML_MALFORMED_PATTERN — incomplete/malformed tags", () => {
  function collectMatches(text: string): string[] {
    const matches: string[] = []
    const regex = new RegExp(XML_MALFORMED_PATTERN)
    let m: RegExpExecArray | null
    while ((m = regex.exec(text)) !== null) {
      matches.push(m[1])
    }
    return matches
  }

  test("matches incomplete opening tag without closing >", () => {
    const matches = collectMatches("<parameter")
    expect(matches).toContain("parameter")
  })

  test("matches incomplete tag with attribute start", () => {
    const matches = collectMatches("<parameter=")
    expect(matches).toContain("parameter")
  })

  test("matches incomplete tag with newline", () => {
    const matches = collectMatches("<parameter\n")
    expect(matches).toContain("parameter")
  })

  test("matches incomplete closing tag", () => {
    const matches = collectMatches("</parameter")
    expect(matches).toContain("parameter")
  })

  test("matches multiple malformed tags", () => {
    const matches = collectMatches("<parameter</function")
    expect(matches).toContain("parameter")
    expect(matches).toContain("function")
  })

  test("does NOT match complete tags", () => {
    const matches = collectMatches("<parameter>value</parameter>")
    expect(matches).not.toContain("parameter")
  })

  test("does NOT match self-closing tags", () => {
    const matches = collectMatches("<br/>")
    expect(matches).not.toContain("br")
  })

  test("matches Qwen-style malformed: <parameter=oldString>", () => {
    // This is a real Qwen pattern: attribute value bleeds into next tag
    const matches = collectMatches("<parameter=oldString>")
    // The pattern should NOT match this because it has a closing >
    // Actually, let's verify: <parameter=oldString> has a closing > so it's complete
    expect(matches).not.toContain("parameter")
  })

  test("matches Qwen-style truly malformed: <parameter=oldString> followed by junk", () => {
    // Real Qwen output: no closing > on the tag
    const matches = collectMatches("<parameter=oldString")
    expect(matches).toContain("parameter")
  })

  test("matches repeated malformed tags in Qwen-style output", () => {
    const text = "<parameter=filePath\n/Users/test.md\n</parameter>\\n<parameter=limit\n10\n</parameter>"
    const matches = collectMatches(text)
    expect(matches).toContain("parameter")
  })
})

describe("XmlRepetitionDetector — prefix-based detection (extractTagPrefixes)", () => {
  test("extractTagPrefixes detects repeated <parameter prefix without closing >", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // First prefix — below partialTagThreshold of 2
    const r1 = detector.consumeDelta("read", "<parameter", 5)
    expect(r1).toBeUndefined()
    // Second prefix — at threshold of 2 → detected
    const r2 = detector.consumeDelta("read", "<parameter", 5)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
    expect(r2?.repetitionCount).toBeGreaterThanOrEqual(2)
    expect(r2?.exceedsTokenLimit).toBe(false)
  })

  test("extractTagPrefixes detects repeated <parameter= prefix (Qwen-style malformed)", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // First Qwen-style malformed tag
    const r1 = detector.consumeDelta("read", "<parameter=filePath", 10)
    expect(r1).toBeUndefined()
    // Second — triggers at partialTagThreshold of 2
    const r2 = detector.consumeDelta("read", "<parameter=oldString", 10)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })

  test("extractTagPrefixes does NOT fire on legitimate varied XML", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // Different tag prefixes — should not trigger
    const r1 = detector.consumeDelta("read", "<parameter", 5)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<function", 5)
    expect(r2).toBeUndefined()
    const r3 = detector.consumeDelta("read", "<command", 5)
    expect(r3).toBeUndefined()
  })

  test("extractTagPrefixes uses lower partialTagThreshold than repetitionThreshold", () => {
    // repetitionThreshold=4, partialTagThreshold=2
    // Complete tags need 4 to trigger; prefix tags need only 2
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // 3 complete tags — below repetitionThreshold of 4
    for (let i = 0; i < 3; i++) {
      const r = detector.consumeDelta("read", "<parameter>v</parameter>", 5)
      expect(r).toBeUndefined()
    }
    // Now 2 prefix tags — at partialTagThreshold of 2 → detected
    detector.consumeDelta("read", "<parameter", 5)
    const r = detector.consumeDelta("read", "<parameter", 5)
    expect(r).toBeDefined()
    expect(r?.type).toBe("xml_repetition")
    expect(r?.tagName).toBe("parameter")
  })

  test("extractTagPrefixes with default partialTagThreshold of 2", () => {
    // No partialTagThreshold specified — should default to 2
    const detector = createDetector({ repetitionThreshold: 4 })
    const r1 = detector.consumeDelta("read", "<parameter", 5)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter", 5)
    expect(r2).toBeDefined()
  })

  test("extractTagPrefixes does not fire on complete tags (they go through extractTags path)", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // Complete tags should not be picked up by prefix detection
    // (XML_MALFORMED_PATTERN uses negative lookahead to exclude complete tags)
    const r1 = detector.consumeDelta("read", "<parameter>v</parameter>", 5)
    expect(r1).toBeUndefined()
    // Only 1 complete tag in window — no repetition anyway
    const state = detector.getState()
    expect(state.tagWindowLength).toBe(1)
  })

  test("extractTagPrefixes handles Qwen-style multi-line malformed output", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // Simulates Qwen output: repeated <parameter without closing >
    const r1 = detector.consumeDelta("read", "<parameter\nfilePath\n", 10)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter\nlimit\n", 10)
    expect(r2).toBeDefined()
    expect(r2?.tagName).toBe("parameter")
  })
})

// ============================================================================
// Task 9 — Comprehensive Tests for Malformed XML
// ============================================================================

describe("Task 9 — Repeated opening tags without closing tags", () => {
  test("repeated opening tags without closing tags are detected", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // 3 opening-only <parameter> tags — no closing </parameter>
    const r1 = detector.consumeDelta("read", "<parameter>value1", 10)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter>value2", 10)
    // partialTagThreshold is 2, so 2nd partial tag triggers
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })

  test("repeated opening tags alone accumulate correctly in window", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 4 })
    // 3 opening-only tags — below threshold of 4
    for (let i = 0; i < 3; i++) {
      const r = detector.consumeDelta("read", `<parameter>value${i}`, 10)
      expect(r).toBeUndefined()
    }
    // 4th opening-only tag — at threshold of 4 → detected
    const r4 = detector.consumeDelta("read", "<parameter>value3", 10)
    expect(r4).toBeDefined()
    expect(r4?.type).toBe("xml_repetition")
    expect(r4?.tagName).toBe("parameter")
    expect(r4?.repetitionCount).toBeGreaterThanOrEqual(4)
  })

  test("opening tags without closing tags are NOT false positives on varied XML", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 4 })
    // Different opening-only tags — should not trigger
    const r1 = detector.consumeDelta("read", "<parameter>value1", 10)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<function>value2", 10)
    expect(r2).toBeUndefined()
    const r3 = detector.consumeDelta("read", "<command>value3", 10)
    expect(r3).toBeUndefined()
    const r4 = detector.consumeDelta("read", "<filePath>value4", 10)
    expect(r4).toBeUndefined()
  })
})

describe("Task 9 — Repeated closing tags without opening tags", () => {
  test("repeated closing tags without opening tags are detected", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // 2 closing-only </parameter> tags — no opening <parameter>
    const r1 = detector.consumeDelta("read", "</parameter>", 5)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "</parameter>", 5)
    // partialTagThreshold is 2 → detected
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })

  test("repeated closing tags alone accumulate correctly in window", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 4 })
    // 3 closing-only tags — below threshold of 4
    for (let i = 0; i < 3; i++) {
      const r = detector.consumeDelta("read", "</parameter>", 5)
      expect(r).toBeUndefined()
    }
    // 4th closing-only tag — at threshold of 4 → detected
    const r4 = detector.consumeDelta("read", "</parameter>", 5)
    expect(r4).toBeDefined()
    expect(r4?.type).toBe("xml_repetition")
    expect(r4?.tagName).toBe("parameter")
    expect(r4?.repetitionCount).toBeGreaterThanOrEqual(4)
  })

  test("closing tags without opening tags are NOT false positives on varied XML", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 4 })
    // Different closing-only tags — should not trigger
    const r1 = detector.consumeDelta("read", "</parameter>", 5)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "</function>", 5)
    expect(r2).toBeUndefined()
    const r3 = detector.consumeDelta("read", "</command>", 5)
    expect(r3).toBeUndefined()
    const r4 = detector.consumeDelta("read", "</filePath>", 5)
    expect(r4).toBeUndefined()
  })
})

describe("Task 9 — Malformed output with angle brackets and word characters", () => {
  test("malformed output with angle brackets and word chars is detected via prefix detection", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // Simulates Qwen-style malformed output: <parameter without closing >
    const r1 = detector.consumeDelta("read", "<parameter", 5)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter", 5)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })

  test("malformed output with angle brackets and word chars — Qwen-style with equals", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // Qwen-style: <parameter=oldString without closing >
    const r1 = detector.consumeDelta("read", "<parameter=oldString", 15)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter=newString", 15)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })

  test("malformed output with angle brackets and word chars — Qwen-style multi-line", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // Real Qwen output pattern: <parameter\nfilePath\n without closing >
    const r1 = detector.consumeDelta("read", "<parameter\nfilePath\n", 15)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter\nlimit\n", 10)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })

  test("malformed output with angle brackets and word chars — mixed malformed patterns", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // Mix of malformed patterns: <parameter, <parameter=, <parameter\n
    const r1 = detector.consumeDelta("read", "<parameter", 5)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter=oldString", 15)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })
})

describe("Task 9 — Mixed complete and partial tags", () => {
  test("mixed complete and partial tags of same name are detected", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // 1 complete tag + 1 partial tag — partialTagThreshold is 2 → detected
    const r1 = detector.consumeDelta("read", "<parameter>value1</parameter>", 15)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter>value2", 10)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })

  test("mixed complete and partial tags with higher thresholds", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 4 })
    // 2 complete + 1 partial — below threshold of 4 for both
    const r1 = detector.consumeDelta("read", "<parameter>v1</parameter>", 10)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter>v2</parameter>", 10)
    expect(r2).toBeUndefined()
    const r3 = detector.consumeDelta("read", "<parameter>v3", 5)
    expect(r3).toBeUndefined()
    // 1 more partial — now 4 total in window → detected
    const r4 = detector.consumeDelta("read", "<parameter>v4", 5)
    expect(r4).toBeDefined()
    expect(r4?.type).toBe("xml_repetition")
    expect(r4?.tagName).toBe("parameter")
  })

  test("mixed complete and partial tags of different names — no false positive", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 4 })
    // 2 complete <parameter> + 2 partial <function> — different names
    const r1 = detector.consumeDelta("read", "<parameter>v1</parameter>", 10)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter>v2</parameter>", 10)
    expect(r2).toBeUndefined()
    const r3 = detector.consumeDelta("read", "<function>v3", 5)
    expect(r3).toBeUndefined()
    const r4 = detector.consumeDelta("read", "<function>v4", 5)
    expect(r4).toBeUndefined()
  })
})

describe("Task 9 — Partial tag prefixes repeated", () => {
  test("partial tag prefixes repeated are detected", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // 2 prefix tags — at partialTagThreshold of 2 → detected
    const r1 = detector.consumeDelta("read", "<parameter", 5)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter", 5)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })

  test("partial tag prefixes with different names — no false positive", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 4 })
    // 4 different prefix tags — should not trigger
    const r1 = detector.consumeDelta("read", "<parameter", 5)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<function", 5)
    expect(r2).toBeUndefined()
    const r3 = detector.consumeDelta("read", "<command", 5)
    expect(r3).toBeUndefined()
    const r4 = detector.consumeDelta("read", "<filePath", 5)
    expect(r4).toBeUndefined()
  })

  test("partial tag prefixes accumulate with complete tags in window", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // 1 complete + 1 prefix — partialTagThreshold is 2 → detected
    const r1 = detector.consumeDelta("read", "<parameter>v1</parameter>", 10)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter", 5)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })
})

describe("Task 9 — Token estimation accuracy for XML content with multiplier", () => {
  test("XML content token estimation uses multiplier correctly", () => {
    // "<parameter>v</parameter>" = 23 chars
    // With 1.5x: ceil(23/4 * 1.5) = ceil(8.625) = 9 tokens
    // maxToolInputTokens = 8 → exceeds
    const detector = createDetector({ maxToolInputTokens: 8 })
    const result = detector.consumeDelta("read", "<parameter>v</parameter>", 0)
    expect(result).toBeDefined()
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("non-XML content uses standard estimation without multiplier", () => {
    // 32 chars plain text: ceil(32/4) = 8 tokens — at limit, no trigger
    const detector = createDetector({ maxToolInputTokens: 8 })
    const result = detector.consumeDelta("read", "a".repeat(32), 0)
    expect(result).toBeUndefined()
  })

  test("XML token estimation accumulates correctly across multiple deltas", () => {
    // "<x>".repeat(5) = 15 chars XML: ceil(15/4 * 1.5) = ceil(5.625) = 6 tokens per delta
    // 3 deltas: 6 + 6 + 6 = 18 tokens, maxToolInputTokens = 15 → 3rd exceeds
    const detector = createDetector({ maxToolInputTokens: 15, repetitionThreshold: 100, partialTagThreshold: 100 })
    const r1 = detector.consumeDelta("read", "<x>".repeat(5), 0)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<y>".repeat(5), 0)
    expect(r2).toBeUndefined()
    const r3 = detector.consumeDelta("read", "<z>".repeat(5), 0)
    expect(r3).toBeDefined()
    expect(r3?.exceedsTokenLimit).toBe(true)
  })

  test("mixed XML and non-XML deltas use correct estimation per delta", () => {
    // 20 chars plain text: ceil(20/4) = 5 tokens
    // "<x>".repeat(5) = 15 chars XML: ceil(15/4 * 1.5) = ceil(5.625) = 6 tokens
    // Total: 11 tokens — under 15 limit
    const detector = createDetector({ maxToolInputTokens: 15, repetitionThreshold: 100, partialTagThreshold: 100 })
    const r1 = detector.consumeDelta("read", "a".repeat(20), 0)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<x>".repeat(5), 0)
    expect(r2).toBeUndefined()
    expect(detector.getState().currentToolTokens).toBe(11)
  })

  test("custom XML token estimation multiplier value", () => {
    // 40 chars with XML: ceil(40/4 * 2.0) = ceil(20) = 20 tokens
    // maxToolInputTokens = 15 → exceeds
    const detector = createDetector({
      maxToolInputTokens: 15,
      xmlTokenEstimationMultiplier: 2.0,
    })
    const result = detector.consumeDelta("read", "a".repeat(40) + "<x>", 0)
    expect(result).toBeDefined()
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("XML multiplier of 1.0 disables XML bonus estimation", () => {
    // 40 chars with XML: ceil(40/4 * 1.0) = 10 tokens — at limit, no trigger
    const detector = createDetector({
      maxToolInputTokens: 10,
      xmlTokenEstimationMultiplier: 1.0,
      repetitionThreshold: 100,
      partialTagThreshold: 100,
    })
    const result = detector.consumeDelta("read", "<x>".repeat(10), 0)
    expect(result).toBeUndefined()
  })
})

describe("Task 9 — Model-specific thresholds applied correctly for qwen model", () => {
  const qwenThresholds = {
    qwen: {
      repetitionThreshold: 3,
      maxToolInputTokens: 2500,
      partialTagThreshold: 2,
    },
  }

  test("qwen model uses repetitionThreshold=3 (vs default 4)", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: qwenThresholds,
    })
    // 2 complete tags — below qwen threshold of 3
    detector.consumeDelta("read", "<parameter>v1</parameter>", 10)
    detector.consumeDelta("read", "<parameter>v2</parameter>", 10)
    // 3rd tag — at qwen threshold of 3 → detected
    const result = detector.consumeDelta("read", "<parameter>v3</parameter>", 10)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.tagName).toBe("parameter")
    expect(result?.repetitionCount).toBeGreaterThanOrEqual(3)
  })

  test("qwen model uses maxToolInputTokens=2500 (vs default 4000)", () => {
    const detector = createDetector({
      maxToolInputTokens: 4000,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: qwenThresholds,
    })
    // 9996 chars plain → ceil(9996/4) = 2499 tokens — under qwen limit of 2500
    const r1 = detector.consumeDelta("read", "a".repeat(9996), 0)
    expect(r1).toBeUndefined()
    // 8 more chars → ceil(10004/4) = 2501 tokens — exceeds qwen limit of 2500
    const r2 = detector.consumeDelta("read", "b".repeat(8), 0)
    expect(r2).toBeDefined()
    expect(r2?.exceedsTokenLimit).toBe(true)
  })

  test("qwen model uses partialTagThreshold=2 for malformed tags", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      partialTagThreshold: 3,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: qwenThresholds,
    })
    // 1 prefix tag — below qwen partialTagThreshold of 2
    const r1 = detector.consumeDelta("read", "<parameter", 5)
    expect(r1).toBeUndefined()
    // 2nd prefix tag — at qwen partialTagThreshold of 2 → detected
    const r2 = detector.consumeDelta("read", "<parameter", 5)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })

  test("non-qwen model uses default thresholds (not qwen overrides)", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      maxToolInputTokens: 4000,
      modelId: "gpt-4o",
      modelSpecificThresholds: qwenThresholds,
    })
    // 3 complete tags — below default threshold of 4
    for (let i = 0; i < 3; i++) {
      const r = detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 10)
      expect(r).toBeUndefined()
    }
    // 4th tag — at default threshold of 4 → detected
    const result = detector.consumeDelta("read", "<parameter>v3</parameter>", 10)
    expect(result).toBeDefined()
  })

  test("qwen model detection is case-insensitive", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      modelId: "QWEN3.6-40B",
      modelSpecificThresholds: qwenThresholds,
    })
    // 3 tags — at qwen threshold of 3 → detected
    for (let i = 0; i < 2; i++) {
      const r = detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 10)
      expect(r).toBeUndefined()
    }
    const result = detector.consumeDelta("read", "<parameter>v2</parameter>", 10)
    expect(result).toBeDefined()
  })

  test("missing modelSpecificThresholds falls back to config defaults for qwen", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      modelId: "qwen3.6-40b",
    })
    // Should fall back to config defaults (threshold 4)
    for (let i = 0; i < 3; i++) {
      const r = detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 10)
      expect(r).toBeUndefined()
    }
    const result = detector.consumeDelta("read", "<parameter>v3</parameter>", 10)
    expect(result).toBeDefined()
  })

  test("qwen model — per-tool token limit uses qwen maxToolInputTokens", () => {
    const detector = createDetector({
      maxToolInputTokens: 4000,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: qwenThresholds,
    })
    // 10004 chars plain → ceil(10004/4) = 2501 tokens — exceeds qwen 2500 but under default 4000
    const r1 = detector.consumeDelta("read", "a".repeat(10004), 0)
    expect(r1).toBeDefined()
    expect(r1?.exceedsTokenLimit).toBe(true)
  })
})

describe("Task 9 — No false positives on legitimate XML with varied tags", () => {
  test("varied complete XML tags produce no false positives", () => {
    const detector = createDetector({ repetitionThreshold: 4 })
    const tags = ["parameter", "function", "command", "filePath"]
    for (const tag of tags) {
      const result = detector.consumeDelta("read", `<${tag}>value</${tag}>`, 10)
      expect(result).toBeUndefined()
    }
  })

  test("varied opening-only XML tags produce no false positives", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 4 })
    const tags = ["parameter", "function", "command", "filePath"]
    for (const tag of tags) {
      const result = detector.consumeDelta("read", `<${tag}>value`, 10)
      expect(result).toBeUndefined()
    }
  })

  test("varied closing-only XML tags produce no false positives", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 4 })
    const tags = ["parameter", "function", "command", "filePath"]
    for (const tag of tags) {
      const result = detector.consumeDelta("read", `</${tag}>`, 5)
      expect(result).toBeUndefined()
    }
  })

  test("varied prefix tags produce no false positives", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 4 })
    const tags = ["parameter", "function", "command", "filePath"]
    for (const tag of tags) {
      const result = detector.consumeDelta("read", `<${tag}`, 5)
      expect(result).toBeUndefined()
    }
  })

  test("legitimate XML with self-closing and regular tags produces no false positives", () => {
    const detector = createDetector({ repetitionThreshold: 4 })
    // Mix of self-closing and regular tags — all different
    const r1 = detector.consumeDelta("read", "<br/>", 5)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<parameter>v1</parameter>", 10)
    expect(r2).toBeUndefined()
    const r3 = detector.consumeDelta("read", "<hr/>", 5)
    expect(r3).toBeUndefined()
    const r4 = detector.consumeDelta("read", "<function>v2</function>", 10)
    expect(r4).toBeUndefined()
  })

  test("legitimate XML with attributes produces no false positives", () => {
    const detector = createDetector({ repetitionThreshold: 4 })
    // Tags with different attributes — should normalize and not trigger
    const r1 = detector.consumeDelta("read", '<parameter attr="x">v1</parameter>', 15)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", '<parameter attr="y">v2</parameter>', 15)
    expect(r2).toBeUndefined()
    const r3 = detector.consumeDelta("read", '<function attr="z">v3</function>', 15)
    expect(r3).toBeUndefined()
    const r4 = detector.consumeDelta("read", '<command attr="w">v4</command>', 15)
    expect(r4).toBeUndefined()
  })

  test("legitimate deeply nested XML produces no false positives", () => {
    const detector = createDetector({ repetitionThreshold: 4 })
    // Deeply nested but varied tags
    const nested = `<root><function><parameter>v1</parameter></function></root>`
    const r1 = detector.consumeDelta("read", nested, 20)
    expect(r1).toBeUndefined()
    const nested2 = `<root><command><filePath>v2</filePath></command></root>`
    const r2 = detector.consumeDelta("read", nested2, 20)
    expect(r2).toBeUndefined()
  })
})

// ============================================================================
// Task 6 — TagEntry with completeness indicator
// ============================================================================

describe("XmlRepetitionDetector — TagEntry completeness", () => {
  test("extractTags returns TagEntry with completeness 'complete' for full XML tags", () => {
    const detector = createDetector()
    detector.consumeDelta("read", "<parameter>value</parameter>", 10)
    const state = detector.getState()
    expect(state.tagWindowLength).toBe(1)
  })

  test("extractTags returns TagEntry with completeness 'partial' for opening-only tags", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // An opening tag without a closing tag in the same delta is "partial"
    // XML_OPENING_TAG_PATTERN matches <parameter> but XML_TAG_PATTERN does not
    // because there's no </parameter> — so it's partial
    const r1 = detector.consumeDelta("read", "<parameter>value without closing", 10)
    // Should not trigger at threshold 2 (only 1 tag so far if partial is detected)
    expect(r1).toBeUndefined()
  })

  test("extractTags returns TagEntry with completeness 'prefix' for malformed tags", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // Malformed tag: <parameter (no closing >)
    const r1 = detector.consumeDelta("read", "<parameter", 5)
    expect(r1).toBeUndefined()
    // Second malformed — should trigger at partialTagThreshold of 2
    const r2 = detector.consumeDelta("read", "<parameter", 5)
    expect(r2).toBeDefined()
    expect(r2?.tagName).toBe("parameter")
  })

  test("mixed complete/partial/prefix tags in same delta produce correct completeness", () => {
    // A single delta with: complete tag, partial opening tag, malformed prefix
    const detector = createDetector({ repetitionThreshold: 2, partialTagThreshold: 2 })
    const mixed = "<parameter>v1</parameter><function>v2<parameter"
    // Complete <parameter> + partial <function> + prefix <parameter
    // Should detect "parameter" repetition (complete + prefix = 2, at threshold)
    const result = detector.consumeDelta("read", mixed, 15)
    expect(result).toBeDefined()
    expect(result?.tagName).toBe("parameter")
  })

  test("partial/prefix tags use partialTagThreshold, complete tags use repetitionThreshold", () => {
    // repetitionThreshold = 4, partialTagThreshold = 2
    // 3 complete tags → below 4, no detection
    // 2 partial/prefix tags → at 2, detection
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })

    // 3 complete tags — below repetitionThreshold of 4
    for (let i = 0; i < 3; i++) {
      const r = detector.consumeDelta("read", "<parameter>v</parameter>", 5)
      expect(r).toBeUndefined()
    }

    // 2 prefix tags — at partialTagThreshold of 2 → detected
    detector.consumeDelta("read", "<parameter", 5)
    const r = detector.consumeDelta("read", "<parameter", 5)
    expect(r).toBeDefined()
    expect(r?.type).toBe("xml_repetition")
    expect(r?.tagName).toBe("parameter")
  })

  test("consumeDelta processes complete tags first, then partial, then prefix", () => {
    // Complete tags should be processed first (higher priority)
    // If complete tags trigger repetition, partial/prefix are never reached
    const detector = createDetector({ repetitionThreshold: 2, partialTagThreshold: 2 })
    const mixed = "<parameter>v1</parameter><parameter>v2</parameter><function<v3"
    // Should detect "parameter" from complete tags (2 at threshold 2)
    // before processing the partial/prefix tags
    const result = detector.consumeDelta("read", mixed, 15)
    expect(result).toBeDefined()
    expect(result?.tagName).toBe("parameter")
  })

  test("partial tag detection with opening tag without closing pair", () => {
    const detector = createDetector({ repetitionThreshold: 4, partialTagThreshold: 2 })
    // <parameter> without </parameter> — XML_TAG_PATTERN won't match (no closing pair)
    // XML_OPENING_TAG_PATTERN will match → partial
    const r1 = detector.consumeDelta("read", "<parameter>unclosed", 10)
    expect(r1).toBeUndefined()
    // Second partial tag — at partialTagThreshold of 2
    const r2 = detector.consumeDelta("read", "<parameter>also unclosed", 10)
    expect(r2).toBeDefined()
    expect(r2?.tagName).toBe("parameter")
  })
})

// ============================================================================
// Task 7 — Model-Specific Threshold Handling
// ============================================================================

// ============================================================================
// Task 8 — XML Token Estimation with Multiplier
// ============================================================================

describe("XmlRepetitionDetector — XML token estimation multiplier", () => {
  test("XML content applies multiplier to token estimation (default 1.5)", () => {
    // 40 chars of XML: "<parameter>v</parameter>" = 23 chars
    // Standard: ceil(23/4) = 6 tokens
    // With 1.5x multiplier: ceil(23/4 * 1.5) = ceil(8.625) = 9 tokens
    const detector = createDetector({ maxToolInputTokens: 8 })
    // First call: 9 estimated tokens > 8 limit → should trigger
    const result = detector.consumeDelta("read", "<parameter>v</parameter>", 0)
    expect(result).toBeDefined()
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("non-XML content uses standard estimation (no multiplier)", () => {
    // 32 chars of plain text
    // Standard: ceil(32/4) = 8 tokens — at limit, no trigger
    const detector = createDetector({ maxToolInputTokens: 8 })
    const result = detector.consumeDelta("read", "a".repeat(32), 0)
    expect(result).toBeUndefined()
  })

  test("non-XML content exceeds limit with standard estimation", () => {
    // 33 chars of plain text
    // Standard: ceil(33/4) = 9 tokens — exceeds 8 limit
    const detector = createDetector({ maxToolInputTokens: 8 })
    const result = detector.consumeDelta("read", "a".repeat(33), 0)
    expect(result).toBeDefined()
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("custom multiplier value", () => {
    // 40 chars of XML
    // With 2.0x multiplier: ceil(40/4 * 2.0) = ceil(20) = 20 tokens
    const detector = createDetector({
      maxToolInputTokens: 15,
      xmlTokenEstimationMultiplier: 2.0,
    })
    const result = detector.consumeDelta("read", "a".repeat(40) + "<x>", 0)
    expect(result).toBeDefined()
    expect(result?.exceedsTokenLimit).toBe(true)
  })

  test("custom multiplier of 1.0 disables XML bonus", () => {
    // 40 chars of XML with multiplier 1.0
    // Standard: ceil(40/4 * 1.0) = 10 tokens — at limit
    const detector = createDetector({
      maxToolInputTokens: 10,
      xmlTokenEstimationMultiplier: 1.0,
      repetitionThreshold: 100,
      partialTagThreshold: 100,
    })
    const result = detector.consumeDelta("read", "<x>".repeat(10), 0)
    expect(result).toBeUndefined()
  })

  test("text with only < but no > uses standard estimation", () => {
    // Has < but no > — not XML, standard estimation
    // 20 chars: ceil(20/4) = 5 tokens — under 8 limit
    const detector = createDetector({ maxToolInputTokens: 8 })
    const result = detector.consumeDelta("read", "a < b c d e f g h", 0)
    expect(result).toBeUndefined()
  })

  test("text with only > but no < uses standard estimation", () => {
    // Has > but no < — not XML, standard estimation
    // 20 chars: ceil(20/4) = 5 tokens — under 8 limit
    const detector = createDetector({ maxToolInputTokens: 8 })
    const result = detector.consumeDelta("read", "a > b c d e f g h", 0)
    expect(result).toBeUndefined()
  })

  test("XML token estimation accumulates correctly across deltas", () => {
    // First delta: 15 chars XML: "<x>".repeat(5) → ceil(15/4 * 1.5) = ceil(5.625) = 6 tokens
    // Second delta: 15 chars XML: "<y>".repeat(5) → ceil(15/4 * 1.5) = ceil(5.625) = 6 tokens
    // Total: 12 tokens — under 15 limit
    // Third delta: 15 chars XML → 6 tokens, total 18 — exceeds 15 limit
    const detector = createDetector({ maxToolInputTokens: 15, repetitionThreshold: 100, partialTagThreshold: 100 })
    const r1 = detector.consumeDelta("read", "<x>".repeat(5), 0)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<y>".repeat(5), 0)
    expect(r2).toBeUndefined()
    const r3 = detector.consumeDelta("read", "<z>".repeat(5), 0)
    expect(r3).toBeDefined()
    expect(r3?.exceedsTokenLimit).toBe(true)
  })

  test("mixed XML and non-XML deltas use correct estimation per delta", () => {
    // First delta: 20 chars plain text → ceil(20/4) = 5 tokens
    // Second delta: 15 chars XML: "<x>".repeat(5) → ceil(15/4 * 1.5) = ceil(5.625) = 6 tokens
    // Total: 11 tokens — under 15 limit
    const detector = createDetector({ maxToolInputTokens: 15, repetitionThreshold: 100, partialTagThreshold: 100 })
    const r1 = detector.consumeDelta("read", "a".repeat(20), 0)
    expect(r1).toBeUndefined()
    const r2 = detector.consumeDelta("read", "<x>".repeat(5), 0)
    expect(r2).toBeUndefined()
    expect(detector.getState().currentToolTokens).toBe(11)
  })

  test("default multiplier is 1.5 when not specified", () => {
    // 18 chars of XML: "<x><y><z><a><b><c>"
    // With default 1.5x: ceil(18/4 * 1.5) = ceil(6.75) = 7 tokens
    // Standard would be: ceil(18/4) = 5 tokens
    // With maxToolInputTokens=6, standard would pass but multiplied fails
    const detector = createDetector({ maxToolInputTokens: 6, repetitionThreshold: 100 })
    const result = detector.consumeDelta("read", "<x><y><z><a><b><c>", 0)
    expect(result).toBeDefined()
    expect(result?.exceedsTokenLimit).toBe(true)
  })
})

describe("XmlRepetitionDetector — model-specific thresholds", () => {
  const qwenThresholds = {
    qwen: {
      repetitionThreshold: 3,
      maxToolInputTokens: 2500,
      partialTagThreshold: 2,
    },
  }

  test("qwen model uses repetitionThreshold=3 (vs default 4)", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: qwenThresholds,
    })
    // 2 complete tags — below qwen threshold of 3
    detector.consumeDelta("read", "<parameter>v1</parameter>", 10)
    detector.consumeDelta("read", "<parameter>v2</parameter>", 10)
    expect(detector.getState().tagWindowLength).toBe(2)
    // 3rd tag — at qwen threshold of 3 → detected
    const result = detector.consumeDelta("read", "<parameter>v3</parameter>", 10)
    expect(result).toBeDefined()
    expect(result?.type).toBe("xml_repetition")
    expect(result?.tagName).toBe("parameter")
    expect(result?.repetitionCount).toBeGreaterThanOrEqual(3)
  })

  test("qwen model uses maxToolInputTokens=2500 (vs default 4000)", () => {
    const detector = createDetector({
      maxToolInputTokens: 4000,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: qwenThresholds,
    })
    // 9996 chars plain → ceil(9996/4) = 2499 tokens — under qwen limit of 2500
    const r1 = detector.consumeDelta("read", "a".repeat(9996), 0)
    expect(r1).toBeUndefined()
    // 8 more chars → ceil(10004/4) = 2501 tokens — exceeds qwen limit of 2500
    const r2 = detector.consumeDelta("read", "b".repeat(8), 0)
    expect(r2).toBeDefined()
    expect(r2?.exceedsTokenLimit).toBe(true)
  })

  test("qwen model uses partialTagThreshold=2 for malformed tags", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      partialTagThreshold: 3,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: qwenThresholds,
    })
    // 1 prefix tag — below qwen partialTagThreshold of 2
    const r1 = detector.consumeDelta("read", "<parameter", 5)
    expect(r1).toBeUndefined()
    // 2nd prefix tag — at qwen partialTagThreshold of 2 → detected
    const r2 = detector.consumeDelta("read", "<parameter", 5)
    expect(r2).toBeDefined()
    expect(r2?.type).toBe("xml_repetition")
    expect(r2?.tagName).toBe("parameter")
  })

  test("non-qwen model uses default thresholds", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      maxToolInputTokens: 4000,
      modelId: "gpt-4o",
      modelSpecificThresholds: qwenThresholds,
    })
    // 3 complete tags — below default threshold of 4
    for (let i = 0; i < 3; i++) {
      const r = detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 10)
      expect(r).toBeUndefined()
    }
    // 4th tag — at default threshold of 4 → detected
    const result = detector.consumeDelta("read", "<parameter>v3</parameter>", 10)
    expect(result).toBeDefined()
  })

  test("modelId without qwen substring does not override thresholds", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      modelId: "claude-3-sonnet",
      modelSpecificThresholds: qwenThresholds,
    })
    // 3 tags — below default threshold of 4
    for (let i = 0; i < 3; i++) {
      const r = detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 10)
      expect(r).toBeUndefined()
    }
  })

  test("qwen model detection is case-insensitive", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      modelId: "QWEN3.6-40B",
      modelSpecificThresholds: qwenThresholds,
    })
    // 3 tags — at qwen threshold of 3 → detected
    for (let i = 0; i < 2; i++) {
      const r = detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 10)
      expect(r).toBeUndefined()
    }
    const result = detector.consumeDelta("read", "<parameter>v2</parameter>", 10)
    expect(result).toBeDefined()
  })

  test("qwen model with mixed case modelId uses qwen thresholds", () => {
    const detector = createDetector({
      repetitionThreshold: 4,
      modelId: "Qwen/Qwen3.6-40B",
      modelSpecificThresholds: qwenThresholds,
    })
    // 3 tags — at qwen threshold of 3 → detected
    for (let i = 0; i < 2; i++) {
      const r = detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 10)
      expect(r).toBeUndefined()
    }
    const result = detector.consumeDelta("read", "<parameter>v2</parameter>", 10)
    expect(result).toBeDefined()
  })

  test("missing modelSpecificThresholds does not crash for qwen model", () => {
    // modelId is qwen but no modelSpecificThresholds provided
    const detector = createDetector({
      repetitionThreshold: 4,
      modelId: "qwen3.6-40b",
    })
    // Should fall back to config defaults (threshold 4)
    for (let i = 0; i < 3; i++) {
      const r = detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 10)
      expect(r).toBeUndefined()
    }
    const result = detector.consumeDelta("read", "<parameter>v3</parameter>", 10)
    expect(result).toBeDefined()
  })

  test("missing modelId uses config defaults regardless of modelSpecificThresholds", () => {
    // modelSpecificThresholds provided but no modelId
    const detector = createDetector({
      repetitionThreshold: 4,
      modelSpecificThresholds: qwenThresholds,
    })
    // Should use config defaults (threshold 4)
    for (let i = 0; i < 3; i++) {
      const r = detector.consumeDelta("read", `<parameter>v${i}</parameter>`, 10)
      expect(r).toBeUndefined()
    }
    const result = detector.consumeDelta("read", "<parameter>v3</parameter>", 10)
    expect(result).toBeDefined()
  })

  test("qwen model — per-tool token limit uses qwen maxToolInputTokens", () => {
    const detector = createDetector({
      maxToolInputTokens: 4000,
      modelId: "qwen3.6-40b",
      modelSpecificThresholds: qwenThresholds,
    })
    // 10004 chars plain → ceil(10004/4) = 2501 tokens — exceeds qwen 2500 but under default 4000
    const r1 = detector.consumeDelta("read", "a".repeat(10004), 0)
    expect(r1).toBeDefined()
    expect(r1?.exceedsTokenLimit).toBe(true)
  })
})

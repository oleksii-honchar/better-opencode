import { describe, test, expect } from "bun:test"
import type { ModelMessage } from "ai"
import { repairOrphanedToolResults, countAssemblyParts } from "@/session/message-v2"

// ---------------------------------------------------------------------------
// Hand-built fixtures — minimal but realistic ModelMessage shapes derived
// from @ai-sdk/provider-utils@4.0.21 ToolModelMessage / AssistantModelMessage
// types. No mocks of the AI SDK. Assertions check the returned array shape.
// ---------------------------------------------------------------------------

function makeAssistantToolCall(toolCallId: string, toolName = "read"): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName,
        input: {},
      },
    ],
  }
}

function makeAssistantText(text: string): ModelMessage {
  return { role: "assistant", content: text }
}

function makeToolResult(toolCallId: string, toolName = "read", outputText = "ok"): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "text", value: outputText },
      },
    ],
  }
}

function makeUserText(text: string): ModelMessage {
  return { role: "user", content: text }
}

describe("repairOrphanedToolResults", () => {
  // ---- Case 1: paired tool-call + tool-result → preserved ----
  test("preserves a paired tool-call and tool-result", () => {
    const input: ModelMessage[] = [makeAssistantToolCall("call_1"), makeToolResult("call_1")]
    const result = repairOrphanedToolResults(input)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(input[0])
    expect(result[1]).toEqual(input[1])
  })

  test("preserves a paired tool-call when the tool message follows several assistant messages", () => {
    const input: ModelMessage[] = [
      makeAssistantText("Hello"),
      makeAssistantToolCall("call_abc"),
      makeUserText("after tool"),
      makeToolResult("call_abc"),
    ]
    const result = repairOrphanedToolResults(input)

    expect(result).toHaveLength(4)
    expect(result).toEqual(input)
  })

  // ---- Case 2: orphan tool-result (no matching tool-call anywhere) → removed ----
  test("drops an orphan tool-result whose toolCallId has no matching tool-call", () => {
    const input: ModelMessage[] = [makeAssistantText("hi"), makeToolResult("call_orphan")]
    const result = repairOrphanedToolResults(input)

    expect(result).toHaveLength(1)
    // The orphan tool message must be gone
    expect(result.some((m) => m.role === "tool")).toBe(false)
    // The assistant text is preserved
    expect(result[0]).toEqual(input[0])
  })

  test("drops the orphan even when the assistant has other unrelated tool-calls", () => {
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_a"),
      makeToolResult("call_a"),
      makeToolResult("call_orphan_no_match"),
    ]
    const result = repairOrphanedToolResults(input)

    expect(result).toHaveLength(2)
    // No orphan should be in the result
    const toolMessages = result.filter((m) => m.role === "tool")
    expect(toolMessages).toHaveLength(1)
    // The single remaining tool message should be the paired one
    const toolMsg = toolMessages[0]
    expect(Array.isArray(toolMsg.content)).toBe(true)
    if (Array.isArray(toolMsg.content)) {
      const tr = toolMsg.content.find((p) => p.type === "tool-result")
      expect(tr).toBeDefined()
      if (tr && tr.type === "tool-result") {
        expect(tr.toolCallId).toBe("call_a")
      }
    }
  })

  // ---- Case 3: mixed history → only orphan removed, others preserved ----
  test("in mixed history, only the orphan is removed; order is preserved", () => {
    const input: ModelMessage[] = [
      makeUserText("first"),
      makeAssistantText("ack"),
      makeAssistantToolCall("call_x"),
      makeToolResult("call_x"),
      makeUserText("second"),
      makeAssistantToolCall("call_y"),
      makeToolResult("call_y"),
      // orphan inserted in the middle:
      makeToolResult("call_orphan"),
      makeUserText("third"),
      makeAssistantToolCall("call_z"),
      makeToolResult("call_z"),
    ]
    const result = repairOrphanedToolResults(input)

    // 11 in, 1 orphan out → 10 out
    expect(result).toHaveLength(input.length - 1)

    // No tool message in result should carry the orphan id
    for (const msg of result) {
      if (msg.role !== "tool") continue
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          expect(part.toolCallId).not.toBe("call_orphan")
        }
      }
    }

    // Order of remaining messages must equal input order minus the orphan
    const expectedOrder = input.filter(
      (m) =>
        !(
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "tool-result" && p.toolCallId === "call_orphan")
        ),
    )
    expect(result).toEqual(expectedOrder)
  })

  // ---- Case 4: empty input → empty array ----
  test("returns an empty array for empty input", () => {
    const result = repairOrphanedToolResults([])
    expect(result).toEqual([])
    expect(result).toHaveLength(0)
  })

  // ---- Purity / non-mutation ----
  test("does not mutate the input array", () => {
    const input: ModelMessage[] = [makeAssistantToolCall("call_a"), makeToolResult("call_orphan")]
    const before = input.slice()
    const result = repairOrphanedToolResults(input)
    expect(input).toEqual(before)
    expect(input).toHaveLength(2)
    expect(result).toHaveLength(1)
  })

  test("returns a new array reference, not the same one", () => {
    const input: ModelMessage[] = [makeUserText("hi")]
    const result = repairOrphanedToolResults(input)
    expect(result).not.toBe(input)
  })

  // ---- Defensive shape coverage ----
  test("skips assistant messages with string content (no tool-call parts possible)", () => {
    const input: ModelMessage[] = [makeAssistantText("plain string content"), makeToolResult("call_orphan")]
    const result = repairOrphanedToolResults(input)

    // The orphan still gets dropped (no tool-call id found anywhere),
    // and the string-content assistant is preserved.
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(input[0])
  })

  test("does not drop tool messages whose tool-result ids are present in earlier assistant array content", () => {
    const assistant: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool-call", toolCallId: "call_x", toolName: "read", input: {} },
      ],
    }
    const input: ModelMessage[] = [assistant, makeToolResult("call_x")]
    const result = repairOrphanedToolResults(input)

    expect(result).toHaveLength(2)
    expect(result).toEqual(input)
  })

  test("handles a tool message whose content array contains multiple tool-result parts (all must match)", () => {
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_a"),
      makeAssistantToolCall("call_b"),
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_a", toolName: "read", output: { type: "text", value: "a" } },
          { type: "tool-result", toolCallId: "call_b", toolName: "read", output: { type: "text", value: "b" } },
        ],
      },
    ]
    const result = repairOrphanedToolResults(input)
    expect(result).toHaveLength(3)
    expect(result).toEqual(input)
  })

  test("drops a tool message even when only one of its tool-result parts is orphan", () => {
    // Conservative behavior: if any tool-result in a tool message has no
    // matching tool-call, drop the whole tool message. The spec is unambiguous
    // about the goal — eliminate orphan tool-results — and a partial-match
    // tool message is ambiguous to providers.
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_a"),
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_a", toolName: "read", output: { type: "text", value: "a" } },
          { type: "tool-result", toolCallId: "call_orphan", toolName: "read", output: { type: "text", value: "x" } },
        ],
      },
    ]
    const result = repairOrphanedToolResults(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(input[0])
  })

  test("does not drop non-tool-role messages regardless of orphan status", () => {
    // A user message is never an orphan target. Only role === "tool" matters.
    const input: ModelMessage[] = [makeUserText("hello"), makeToolResult("call_orphan")]
    const result = repairOrphanedToolResults(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(input[0])
  })
})

// ---------------------------------------------------------------------------
// countAssemblyParts — diagnostic counter for the env-gated debug log inside
// `toModelMessagesEffect`. The function must be pure and count:
//   - toolCallCount: tool-call parts in assistant messages with array content
//   - toolResultCount: tool-result parts in tool messages with array content
//   - orphanCount: tool messages removed by repairOrphanedToolResults
// ---------------------------------------------------------------------------

describe("countAssemblyParts", () => {
  // ---- Case A: 2 tool-calls, 2 tool-results, 1 orphan ----
  test("returns correct counts for 2 tool-calls, 3 tool-results (2 paired + 1 orphan), 1 orphan message", () => {
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_1", "read"),
      makeAssistantToolCall("call_2", "write"),
      makeToolResult("call_1", "read", "result-1"),
      makeToolResult("call_2", "write", "result-2"),
      makeToolResult("call_orphan", "read", "no-pair"), // orphan tool message
    ]
    // Cross-check: orphanCount must equal what repairOrphanedToolResults drops.
    const repaired = repairOrphanedToolResults(input)
    const droppedByRepair = input.length - repaired.length
    expect(droppedByRepair).toBe(1)

    const counts = countAssemblyParts(input)
    expect(counts.toolCallCount).toBe(2)
    // toolResultCount counts ALL tool-result parts across all tool messages,
    // including orphans (BEFORE-repair semantics per task spec).
    expect(counts.toolResultCount).toBe(3)
    expect(counts.orphanCount).toBe(1)
    expect(counts.orphanCount).toBe(droppedByRepair)
  })

  // ---- Case B: empty fixture, all zeros ----
  test("returns all-zero counts for empty input", () => {
    const input: ModelMessage[] = []
    const counts = countAssemblyParts(input)
    expect(counts).toEqual({
      toolCallCount: 0,
      toolResultCount: 0,
      orphanCount: 0,
    })
  })

  // ---- Case C: 3 tool-calls across 2 assistant messages, 3 tool-results paired, 0 orphans ----
  test("returns correct counts for 3 tool-calls across 2 assistant messages, all paired", () => {
    const input: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_1", toolName: "read", input: {} },
          { type: "tool-call", toolCallId: "call_2", toolName: "write", input: {} },
        ],
      },
      makeToolResult("call_1", "read", "r1"),
      makeToolResult("call_2", "write", "r2"),
      makeAssistantToolCall("call_3", "bash"),
      makeToolResult("call_3", "bash", "r3"),
    ]
    const repaired = repairOrphanedToolResults(input)
    expect(repaired).toHaveLength(input.length) // no drops
    expect(input.length - repaired.length).toBe(0)

    const counts = countAssemblyParts(input)
    expect(counts.toolCallCount).toBe(3)
    expect(counts.toolResultCount).toBe(3)
    expect(counts.orphanCount).toBe(0)
  })

  // ---- Defensive shape coverage ----
  test("toolCallCount ignores non-array content (string assistants)", () => {
    const input: ModelMessage[] = [
      makeAssistantText("plain text"),
      makeAssistantToolCall("call_1"),
      makeToolResult("call_1"),
    ]
    const counts = countAssemblyParts(input)
    expect(counts.toolCallCount).toBe(1)
    expect(counts.toolResultCount).toBe(1)
    expect(counts.orphanCount).toBe(0)
  })

  test("toolResultCount only counts tool-role messages with array content", () => {
    // Intentionally malformed `user` message with a tool-result-shaped part
    // (typed via cast to bypass UserModelMessage content-shape narrowing). The
    // counter must still ignore it — only role === "tool" counts.
    const malformedUserAsToolResult = {
      role: "user",
      content: [
        {
          type: "tool-result",
          toolCallId: "bogus",
          toolName: "read",
          output: { type: "text", value: "x" },
        },
      ],
    } as unknown as ModelMessage
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_1"),
      malformedUserAsToolResult,
      makeToolResult("call_1"),
    ]
    const counts = countAssemblyParts(input)
    expect(counts.toolResultCount).toBe(1)
    expect(counts.toolCallCount).toBe(1)
    expect(counts.orphanCount).toBe(0)
  })

  test("orphanCount equals the number of tool messages removed by repairOrphanedToolResults", () => {
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_a"),
      makeToolResult("call_a"),
      makeToolResult("orphan_1"),
      makeAssistantToolCall("call_b"),
      makeToolResult("call_b"),
      makeToolResult("orphan_2"),
      makeToolResult("orphan_3"),
    ]
    const repaired = repairOrphanedToolResults(input)
    const dropped = input.length - repaired.length
    expect(dropped).toBe(3) // sanity check on the fixture itself

    const counts = countAssemblyParts(input)
    expect(counts.orphanCount).toBe(3)
    expect(counts.orphanCount).toBe(dropped)
    expect(counts.toolCallCount).toBe(2)
    expect(counts.toolResultCount).toBe(2 + 3) // all tool-result parts, including orphan ones
  })

  test("is pure — does not mutate input", () => {
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_1"),
      makeToolResult("call_1"),
      makeToolResult("orphan"),
    ]
    const before = input.slice()
    const counts = countAssemblyParts(input)
    expect(input).toEqual(before)
    expect(counts).toEqual({ toolCallCount: 1, toolResultCount: 2, orphanCount: 1 })
  })
})

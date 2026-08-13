import { describe, test, expect } from "bun:test"
import type { ModelMessage } from "ai"
import { Effect } from "effect"
import { validateMessages } from "@/session/llm"

// ---------------------------------------------------------------------------
// Hand-built fixtures — minimal but realistic ModelMessage shapes derived
// from @ai-sdk/provider-utils@4.0.21 ToolModelMessage / AssistantModelMessage
// types. No mocks of the AI SDK. Assertions check the resolved Effect value
// and the returned array shape.
//
// We deliberately DO NOT assert on logger calls. We verify behavior by
// asserting (a) `Effect.runPromise(validateMessages(...))` resolves/rejects
// as expected and (b) the resolved array has orphans removed.
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

describe("validateMessages", () => {
  // ---- Case 1: orphan detected → orphan removed, Effect succeeds ----
  test("removes an orphan tool-result and resolves successfully (does not fail)", async () => {
    const input: ModelMessage[] = [
      makeUserText("hello"),
      makeToolResult("call_orphan"),
      makeAssistantToolCall("call_abc"),
      makeToolResult("call_abc"),
    ]

    const result = await Effect.runPromise(validateMessages(input))

    // The orphan tool message must be gone
    expect(
      result.some(
        (m) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "tool-result" && p.toolCallId === "call_orphan"),
      ),
    ).toBe(false)

    // 4 in, 1 orphan out → 3 out
    expect(result).toHaveLength(3)

    // The paired tool-result must still be present (sanity)
    expect(
      result.some(
        (m) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "tool-result" && p.toolCallId === "call_abc"),
      ),
    ).toBe(true)
  })

  test("returns a new array (no input mutation) when an orphan is removed", async () => {
    const input: ModelMessage[] = [makeToolResult("call_orphan")]
    const before = input.slice()

    const result = await Effect.runPromise(validateMessages(input))

    // input was not mutated
    expect(input).toEqual(before)
    expect(input).toHaveLength(1)
    // result has the orphan removed
    expect(result).toHaveLength(0)
    // result is a different reference
    expect(result).not.toBe(input)
  })

  test("removes multiple orphan tool-results in one pass", async () => {
    const input: ModelMessage[] = [
      makeUserText("hi"),
      makeToolResult("call_orphan_a"),
      makeAssistantToolCall("call_real"),
      makeToolResult("call_real"),
      makeToolResult("call_orphan_b"),
    ]

    const result = await Effect.runPromise(validateMessages(input))

    // 5 in, 2 orphans out → 3 out
    expect(result).toHaveLength(3)
    // Neither orphan id should appear in the result
    for (const msg of result) {
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          expect(part.toolCallId === "call_orphan_a" || part.toolCallId === "call_orphan_b").toBe(false)
        }
      }
    }
    // The paired tool-result survives
    expect(
      result.some(
        (m) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "tool-result" && p.toolCallId === "call_real"),
      ),
    ).toBe(true)
  })

  // ---- Case 2: no orphans → input array returned unchanged ----
  test("returns the input array unchanged when no orphans are present", async () => {
    const input: ModelMessage[] = [
      makeUserText("hello"),
      makeAssistantToolCall("call_abc"),
      makeToolResult("call_abc"),
    ]

    const result = await Effect.runPromise(validateMessages(input))

    expect(result).toHaveLength(3)
    expect(result).toEqual(input)
  })

  test("returns an empty array unchanged when input is empty", async () => {
    const result = await Effect.runPromise(validateMessages([]))

    expect(result).toEqual([])
    expect(result).toHaveLength(0)
  })

  // ---- Case 3: existing tool-call-input-validation still works ----
  test("fails the Effect when an assistant tool-call has input: undefined", async () => {
    const input: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_abc", toolName: "read", input: undefined }],
      },
    ]

    // Effect.runPromise should reject — the LLMError surfaces from the Effect.
    await expect(Effect.runPromise(validateMessages(input))).rejects.toBeDefined()
  })

  test("fails the Effect when an assistant tool-call has input: null", async () => {
    const input: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_abc", toolName: "read", input: null }],
      },
    ]

    await expect(Effect.runPromise(validateMessages(input))).rejects.toBeDefined()
  })

  // ---- Phase 1 runs before phase 2: existing input validation still wins ----
  test("still fails on missing tool-call input even when an orphan is also present", async () => {
    const input: ModelMessage[] = [
      makeToolResult("call_orphan"),
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_x", toolName: "read", input: undefined }],
      },
    ]

    // The existing input validation is the harder failure: it must reject.
    // Orphan removal is a softer failure (succeed + log) and runs second.
    await expect(Effect.runPromise(validateMessages(input))).rejects.toBeDefined()
  })

  // ---- Phase 2 does not touch non-tool messages ----
  test("does not touch assistant string-content messages or user messages", async () => {
    const input: ModelMessage[] = [
      makeUserText("before"),
      makeAssistantText("ack"),
      makeToolResult("call_orphan"),
      makeUserText("after"),
    ]

    const result = await Effect.runPromise(validateMessages(input))

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual(input[0])
    expect(result[1]).toEqual(input[1])
    expect(result[2]).toEqual(input[3])
  })
})

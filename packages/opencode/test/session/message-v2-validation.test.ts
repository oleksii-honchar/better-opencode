import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MessageV2 } from "../../src/session/message-v2"
import { LLMError } from "@opencode-ai/llm"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

const sessionID = SessionID.make("session")
const messageID = MessageID.make("msg_test")

function makeToolPart(input: unknown, status: MessageV2.ToolState["status"] = "completed"): MessageV2.ToolPart {
  const base = {
    id: PartID.make("prt_tool"),
    sessionID,
    messageID,
    type: "tool" as const,
    callID: "call_test",
    tool: "test_tool",
  }
  if (status === "completed") {
    return {
      ...base,
      state: {
        status: "completed" as const,
        input: input as Record<string, unknown>,
        output: "result",
        title: "Test",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    }
  }
  if (status === "pending") {
    return {
      ...base,
      state: {
        status: "pending" as const,
        input: input as Record<string, unknown>,
        raw: "",
      },
    }
  }
  if (status === "running") {
    return {
      ...base,
      state: {
        status: "running" as const,
        input: input as Record<string, unknown>,
        time: { start: 0 },
      },
    }
  }
  // error
  return {
    ...base,
    state: {
      status: "error" as const,
      input: input as Record<string, unknown>,
      error: "error",
      time: { start: 0, end: 1 },
      metadata: {},
    },
  }
}

describe("session.message-v2.toModelMessagesValidation", () => {
  test("valid input (object) succeeds with raw object (no JSON.stringify)", () => {
    const part = makeToolPart({ query: "foo" })
    const result = Effect.runSync(MessageV2.toModelMessagesValidation(part))
    expect(result).toEqual({ query: "foo" })
  })

  test("valid input (string) succeeds with original string", () => {
    const part = makeToolPart('{"query":"foo"}')
    const result = Effect.runSync(MessageV2.toModelMessagesValidation(part))
    expect(result).toBe('{"query":"foo"}')
  })

  test("valid input (empty object) succeeds with raw empty object", () => {
    const part = makeToolPart({})
    const result = Effect.runSync(MessageV2.toModelMessagesValidation(part))
    expect(result).toEqual({})
  })

  test("undefined input fails with InvalidRequestReason mentioning undefined", () => {
    const part = makeToolPart(undefined)
    let capturedError: unknown = undefined
    const result = Effect.runSync(
      MessageV2.toModelMessagesValidation(part)
        .pipe(
          Effect.catch((e) => { capturedError = e; return Effect.succeed("caught") }),
        ),
    )
    expect(result).toBe("caught")
    expect(capturedError instanceof LLMError).toBe(true)
    const error = capturedError as LLMError
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.message).toContain("call_test")
    expect(error.message).toContain("test_tool")
    expect(error.message).toContain("missing required field")
    expect(error.message).toContain("arguments")
  })

  test("null input fails with InvalidRequestReason mentioning null", () => {
    const part = makeToolPart(null)
    let capturedError: unknown = undefined
    const result = Effect.runSync(
      MessageV2.toModelMessagesValidation(part)
        .pipe(
          Effect.catch((e) => { capturedError = e; return Effect.succeed("caught") }),
        ),
    )
    expect(result).toBe("caught")
    expect(capturedError instanceof LLMError).toBe(true)
    const error = capturedError as LLMError
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.message).toContain("call_test")
    expect(error.message).toContain("test_tool")
    expect(error.message).toContain("missing required field")
    expect(error.message).toContain("arguments")
  })

  test("empty string input succeeds with raw empty string (no serialization)", () => {
    const part = makeToolPart("")
    const result = Effect.runSync(MessageV2.toModelMessagesValidation(part))
    expect(result).toBe("")
  })
})

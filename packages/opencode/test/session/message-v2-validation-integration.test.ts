import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { LLMError } from "@opencode-ai/llm"

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")
const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(id: string, parentID: string): MessageV2.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID,
    modelID: model.api.id,
    providerID: model.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

function makeToolPart(
  messageID: string,
  partID: string,
  callID: string,
  tool: string,
  input: unknown,
  status: MessageV2.ToolState["status"],
  extra?: { output?: string; error?: string; raw?: string; time?: { start: number; end?: number } },
): MessageV2.ToolPart {
  const base = {
    ...basePart(messageID, partID),
    type: "tool" as const,
    callID,
    tool,
  }
  if (status === "completed") {
    return {
      ...base,
      state: {
        status: "completed" as const,
        input: input as Record<string, unknown>,
        output: extra?.output ?? "result",
        title: "Test",
        metadata: {},
        time: extra?.time ?? { start: 0, end: 1 },
      },
    }
  }
  if (status === "pending") {
    return {
      ...base,
      state: {
        status: "pending" as const,
        input: input as Record<string, unknown>,
        raw: extra?.raw ?? "",
      },
    }
  }
  if (status === "running") {
    return {
      ...base,
      state: {
        status: "running" as const,
        input: input as Record<string, unknown>,
        time: extra?.time ?? { start: 0 },
      },
    }
  }
  // error
  return {
    ...base,
    state: {
      status: "error" as const,
      input: input as Record<string, unknown>,
      error: extra?.error ?? "error",
      time: extra?.time ?? { start: 0, end: 1 },
      metadata: {},
    },
  }
}

describe("session.message-v2.toModelMessagesEffect validation integration", () => {
  test("completed tool with valid input succeeds", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          makeToolPart(assistantID, "a1", "call-1", "bash", { cmd: "ls" }, "completed"),
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    expect(result).toHaveLength(3)
    // assistant message should contain the tool call
    const assistantMsg = result.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
  })

  test("completed tool with undefined input fails with LLMError", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          makeToolPart(assistantID, "a1", "call-bad", "meta_search", undefined, "completed"),
        ] as MessageV2.Part[],
      },
    ]

    let capturedError: unknown = undefined
    try {
      await MessageV2.toModelMessages(input, model)
    } catch (e) {
      capturedError = e
    }

    expect(capturedError).toBeDefined()
    expect(capturedError instanceof LLMError).toBe(true)
    const error = capturedError as LLMError
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.message).toContain("call-bad")
    expect(error.message).toContain("meta_search")
    expect(error.message).toContain("missing required field")
  })

  test("error tool with output and undefined input fails with LLMError", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          makeToolPart(assistantID, "a1", "call-bad", "meta_search", undefined, "error", {
            output: "partial output",
            error: "something went wrong",
          }),
        ] as MessageV2.Part[],
      },
    ]

    let capturedError: unknown = undefined
    try {
      await MessageV2.toModelMessages(input, model)
    } catch (e) {
      capturedError = e
    }

    expect(capturedError).toBeDefined()
    expect(capturedError instanceof LLMError).toBe(true)
    const error = capturedError as LLMError
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.message).toContain("call-bad")
  })

  test("error tool without output and undefined input fails with LLMError", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          makeToolPart(assistantID, "a1", "call-bad", "meta_search", undefined, "error"),
        ] as MessageV2.Part[],
      },
    ]

    let capturedError: unknown = undefined
    try {
      await MessageV2.toModelMessages(input, model)
    } catch (e) {
      capturedError = e
    }

    expect(capturedError).toBeDefined()
    expect(capturedError instanceof LLMError).toBe(true)
    const error = capturedError as LLMError
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.message).toContain("call-bad")
  })

  test("pending tool with undefined input fails with LLMError", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          makeToolPart(assistantID, "a1", "call-bad", "meta_search", undefined, "pending"),
        ] as MessageV2.Part[],
      },
    ]

    let capturedError: unknown = undefined
    try {
      await MessageV2.toModelMessages(input, model)
    } catch (e) {
      capturedError = e
    }

    expect(capturedError).toBeDefined()
    expect(capturedError instanceof LLMError).toBe(true)
    const error = capturedError as LLMError
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.message).toContain("call-bad")
  })

  test("running tool with undefined input fails with LLMError", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          makeToolPart(assistantID, "a1", "call-bad", "meta_search", undefined, "running"),
        ] as MessageV2.Part[],
      },
    ]

    let capturedError: unknown = undefined
    try {
      await MessageV2.toModelMessages(input, model)
    } catch (e) {
      capturedError = e
    }

    expect(capturedError).toBeDefined()
    expect(capturedError instanceof LLMError).toBe(true)
    const error = capturedError as LLMError
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.message).toContain("call-bad")
  })

  test("completed tool with empty string input fails with LLMError", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          makeToolPart(assistantID, "a1", "call-bad", "meta_search", "", "completed"),
        ] as MessageV2.Part[],
      },
    ]

    let capturedError: unknown = undefined
    try {
      await MessageV2.toModelMessages(input, model)
    } catch (e) {
      capturedError = e
    }

    expect(capturedError).toBeDefined()
    expect(capturedError instanceof LLMError).toBe(true)
    const error = capturedError as LLMError
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.message).toContain("empty")
  })

  test("completed tool with empty object input succeeds ({} is valid)", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          makeToolPart(assistantID, "a1", "call-1", "bash", {}, "completed"),
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    expect(result).toHaveLength(3)
    const assistantMsg = result.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
  })

  test("validated JSON string is used as input (serialized form)", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          makeToolPart(assistantID, "a1", "call-1", "bash", { cmd: "ls" }, "completed"),
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    // The tool-call input should be the serialized JSON string
    const assistantMsg = result.find((m) => m.role === "assistant")
    const content = assistantMsg?.content as any[]
    const toolCall = content?.find((p) => p.type === "tool-call")
    expect(toolCall).toBeDefined()
    // After validation, input is the JSON string (which AI SDK then parses)
    // The key point: the input value comes from validation, not raw part.state.input
    expect(toolCall.input).toBe('{"cmd":"ls"}')
  })
})

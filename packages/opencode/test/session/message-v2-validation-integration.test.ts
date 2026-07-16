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

type CompletedToolTime = Extract<MessageV2.ToolState, { status: "completed" }>["time"]
type ErrorToolTime = Extract<MessageV2.ToolState, { status: "error" }>["time"]
type RunningToolTime = Extract<MessageV2.ToolState, { status: "running" }>["time"]

type ToolPartExtra = {
  output?: string
  error?: string
  raw?: string
}

type MakeToolPartArgs =
  | [
      messageID: string,
      partID: string,
      callID: string,
      tool: string,
      input: unknown,
      status: "completed",
      extra?: ToolPartExtra & { time?: CompletedToolTime },
    ]
  | [
      messageID: string,
      partID: string,
      callID: string,
      tool: string,
      input: unknown,
      status: "pending",
      extra?: ToolPartExtra,
    ]
  | [
      messageID: string,
      partID: string,
      callID: string,
      tool: string,
      input: unknown,
      status: "running",
      extra?: ToolPartExtra & { time?: RunningToolTime },
    ]
  | [
      messageID: string,
      partID: string,
      callID: string,
      tool: string,
      input: unknown,
      status: "error",
      extra?: ToolPartExtra & { time?: ErrorToolTime },
    ]

function makeToolPart(...args: MakeToolPartArgs): MessageV2.ToolPart {
  const [messageID, partID, callID, tool, input, status, extra] = args
  const base = {
    ...basePart(messageID, partID),
    type: "tool" as const,
    callID,
    tool,
  }
  if (status === "completed") {
    const time: CompletedToolTime = extra?.time ?? { start: 0, end: 1 }
    return {
      ...base,
      state: {
        status: "completed" as const,
        input: input as Record<string, unknown>,
        output: extra?.output ?? "result",
        title: "Test",
        metadata: {},
        time,
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
    const time: RunningToolTime = extra?.time ?? { start: 0 }
    return {
      ...base,
      state: {
        status: "running" as const,
        input: input as Record<string, unknown>,
        time,
      },
    }
  }
  const time: ErrorToolTime = extra?.time ?? { start: 0, end: 1 }
  return {
    ...base,
    state: {
      status: "error" as const,
      input: input as Record<string, unknown>,
      error: extra?.error ?? "error",
      time,
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

  test("completed tool with empty string input succeeds (no serialization validation)", async () => {
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

    const result = await MessageV2.toModelMessages(input, model)
    expect(result).toHaveLength(3)
    const assistantMsg = result.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
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

  test("tool call input is raw object (not double-serialized)", async () => {
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
    // The tool-call input should be the raw object (no JSON.stringify from validation)
    const assistantMsg = result.find((m) => m.role === "assistant")
    const content = assistantMsg?.content as any[]
    const toolCall = content?.find((p) => p.type === "tool-call")
    expect(toolCall).toBeDefined()
    // Input is now the raw object — protocol layer handles serialization via encodeJson
    expect(toolCall.input).toEqual({ cmd: "ls" })
  })
})

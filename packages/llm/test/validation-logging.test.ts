import { describe, expect } from "bun:test"
import { Effect, Layer, Logger, LogLevel } from "effect"
import { LLM, Message, ToolCallPart } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import { Auth, LLMClient } from "../src/route"
import { it } from "./lib/effect"

const chatModel = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const responsesModel = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4.1-mini" })

/**
 * Creates a Logger that captures `Warn`-level log messages into a mutable array.
 * Returns [captureArray, layer] so the test can assert on captured messages.
 */
const makeCaptureLogger = (): [string[], Layer.Layer<never, never, never>] => {
  const captured: string[] = []
  const logger = Logger.make((log) => {
    if (log.logLevel === "Warn") {
      captured.push(String(log.message))
    }
  })
  const layer = Logger.layer([logger])
  return [captured, layer]
}

describe("Validation failure logging", () => {
  it.effect("logs a warning when tool call input is undefined (openai-chat)", () =>
    Effect.gen(function* () {
      const [captured, loggerLayer] = makeCaptureLogger()
      yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_missing_input",
          model: chatModel,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: undefined })]),
          ],
        }),
      ).pipe(
        Effect.provide(loggerLayer),
        Effect.flip,
      )

      const logText = captured.join(" ")
      expect(logText).toContain("call_1")
      expect(logText).toContain("lookup")
      expect(logText).toContain("arguments")
      expect(logText).toContain("openai-chat")
    }),
  )

  it.effect("logs a warning when tool call input is null (openai-chat)", () =>
    Effect.gen(function* () {
      const [captured, loggerLayer] = makeCaptureLogger()
      yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_null_input",
          model: chatModel,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_2", name: "bash", input: null })]),
          ],
        }),
      ).pipe(
        Effect.provide(loggerLayer),
        Effect.flip,
      )

      const logText = captured.join(" ")
      expect(logText).toContain("call_2")
      expect(logText).toContain("bash")
      expect(logText).toContain("arguments")
      expect(logText).toContain("openai-chat")
    }),
  )

  it.effect("logs a warning when tool call input is undefined (openai-responses)", () =>
    Effect.gen(function* () {
      const [captured, loggerLayer] = makeCaptureLogger()
      yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_missing_input",
          model: responsesModel,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: undefined })]),
          ],
        }),
      ).pipe(
        Effect.provide(loggerLayer),
        Effect.flip,
      )

      const logText = captured.join(" ")
      expect(logText).toContain("call_1")
      expect(logText).toContain("lookup")
      expect(logText).toContain("arguments")
      expect(logText).toContain("openai-responses")
    }),
  )

  it.effect("logs a warning when tool call input is null (openai-responses)", () =>
    Effect.gen(function* () {
      const [captured, loggerLayer] = makeCaptureLogger()
      yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_null_input",
          model: responsesModel,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_2", name: "bash", input: null })]),
          ],
        }),
      ).pipe(
        Effect.provide(loggerLayer),
        Effect.flip,
      )

      const logText = captured.join(" ")
      expect(logText).toContain("call_2")
      expect(logText).toContain("bash")
      expect(logText).toContain("arguments")
      expect(logText).toContain("openai-responses")
    }),
  )

  it.effect("does not log a warning when tool call input is valid (openai-chat)", () =>
    Effect.gen(function* () {
      const [captured, loggerLayer] = makeCaptureLogger()
      yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_valid_input",
          model: chatModel,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_ok", name: "lookup", input: { query: "weather" } })]),
          ],
        }),
      ).pipe(Effect.provide(loggerLayer))

      const logText = captured.join(" ")
      expect(logText).not.toContain("call_ok")
    }),
  )

  it.effect("does not log a warning when tool call input is valid (openai-responses)", () =>
    Effect.gen(function* () {
      const [captured, loggerLayer] = makeCaptureLogger()
      yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_valid_input",
          model: responsesModel,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_ok", name: "lookup", input: { query: "weather" } })]),
          ],
        }),
      ).pipe(Effect.provide(loggerLayer))

      const logText = captured.join(" ")
      expect(logText).not.toContain("call_ok")
    }),
  )
})

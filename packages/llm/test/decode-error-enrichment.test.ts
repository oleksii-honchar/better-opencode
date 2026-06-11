import { describe, expect } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LLM, LLMEvent, LLMRequest } from "../src"
import { Auth } from "../src/route"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { tool } from "../src/tool"
import { ToolRuntime } from "../src/tool-runtime"
import { it } from "./lib/effect"
import * as TestToolRuntime from "./lib/tool-runtime"
import { scriptedResponses } from "./lib/http"
import { deltaChunk, finishChunk, toolCallChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const baseRequest = LLM.request({
  id: "req_1",
  model,
  prompt: "Use the tool.",
})

const get_weather = tool({
  description: "Get current weather for a city.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
  execute: () => Effect.succeed({ temperature: 22, condition: "sunny" }),
})

describe("decodeAndExecute error enrichment", () => {
  /**
   * When a raw string is passed as tool call input (bypassing the protocol
   * layer's JSON parsing), the error message should include the raw input
   * hint so the LLM can see what went wrong.
   *
   * We use ToolRuntime.stream directly — not through SSE fixtures — so we
   * can inject a raw string as `input` instead of an already-parsed object.
   */
  it.effect("enriches error with raw input hint when call.input is a string", () =>
    Effect.gen(function* () {
      const events = Array.from(
        yield* ToolRuntime.stream({
          request: baseRequest,
          tools: { get_weather },
          stopWhen: ToolRuntime.stepCountIs(1),
          stream: () =>
            Stream.fromIterable<LLMEvent>([
              LLMEvent.stepStart({ index: 0 }),
              // Pass raw JSON string as input — decodeAndExecute will see
              // typeof call.input === "string" and include the raw hint.
              LLMEvent.toolCall({ id: "call_1", name: "get_weather", input: '{"city":42}' }),
              LLMEvent.stepFinish({
                index: 0,
                reason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              }),
              LLMEvent.finish({
                reason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              }),
            ]),
        }).pipe(Stream.runCollect),
      )

      const toolError = events.find(LLMEvent.is.toolError)
      expect(toolError).toBeDefined()
      expect(toolError!.message).toContain("Invalid tool input")
      expect(toolError!.message).toContain("Raw input")
      expect(toolError!.message).toContain('{"city":42}')
    }),
  )

  /**
   * When an already-parsed object is passed as tool call input (the normal
   * streaming path), the error message should use the fallback format
   * without "Raw input:".
   */
  it.effect("falls back to basic format when call.input is an object", () =>
    Effect.gen(function* () {
      const events = Array.from(
        yield* ToolRuntime.stream({
          request: baseRequest,
          tools: { get_weather },
          stopWhen: ToolRuntime.stepCountIs(1),
          stream: () =>
            Stream.fromIterable<LLMEvent>([
              LLMEvent.stepStart({ index: 0 }),
              // Pass parsed object as input — decodeAndExecute will see
              // typeof call.input !== "string" and use the fallback format.
              LLMEvent.toolCall({ id: "call_2", name: "get_weather", input: { city: 42 } }),
              LLMEvent.stepFinish({
                index: 0,
                reason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              }),
              LLMEvent.finish({
                reason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              }),
            ]),
        }).pipe(Stream.runCollect),
      )

      const toolError = events.find(LLMEvent.is.toolError)
      expect(toolError).toBeDefined()
      expect(toolError!.message).toContain("Invalid tool input")
      expect(toolError!.message).not.toContain("Raw input")
    }),
  )

  /**
   * The existing streaming path (through the SSE protocol layer) should
   * still produce valid tool-error messages that contain "Invalid tool input".
   * This verifies backward compatibility with the normal flow.
   */
  it.effect("streaming path still produces valid tool-error messages", () =>
    Effect.gen(function* () {
      const layer = scriptedResponses([
        sseEvents(toolCallChunk("call_1", "get_weather", '{"city":42}'), finishChunk("tool_calls")),
        sseEvents(deltaChunk({ role: "assistant", content: "Done." }), finishChunk("stop")),
      ])

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { get_weather } }).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )

      const toolError = events.find(LLMEvent.is.toolError)
      expect(toolError).toBeDefined()
      expect(toolError!.message).toContain("Invalid tool input")
      // In the streaming path, parseToolInput parses the JSON first,
      // so call.input is the parsed object {city: 42}, not a string.
      // Hence "Raw input" is NOT present (fallback path).
      expect(toolError!.message).not.toContain("Raw input")
    }),
  )
})

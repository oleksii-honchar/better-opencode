import { describe, test, expect, beforeEach, mock } from "bun:test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Layer from "effect/Layer"
import type { Context, ExecuteResult } from "./tool"
import * as Truncate from "./truncate"
import * as Agent from "@/agent/agent"

// ---------------------------------------------------------------------------
// Mocks — capture calls to Log.toolsLog
// ---------------------------------------------------------------------------

const toolsLogCalls: Record<string, unknown>[] = []

// Mock the Log module before importing tool.ts
mock.module("@opencode-ai/core/util/log", () => ({
  toolsLog: (entry: Record<string, unknown>) => {
    toolsLogCalls.push(entry)
  },
}))

// Re-import tool.ts after mocking so it picks up our mocked Log
const { define: defineTool, init: initTool } = await import("./tool")

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const mockTruncate: Truncate.Interface = {
  cleanup: () => Effect.void,
  write: (text) => Effect.succeed(text),
  output: (text) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
}

const mockTruncateAlways: Truncate.Interface = {
  cleanup: () => Effect.void,
  write: (text) => Effect.succeed("/tmp/truncated.txt"),
  output: (text) =>
    Effect.succeed({
      content: `truncated:${text.slice(0, 20)}`,
      truncated: true,
      outputPath: "/tmp/truncated.txt",
    }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
}

const mockAgent: Agent.Interface = {
  get: (name) => Effect.succeed({
    name,
    description: "",
    mode: "primary",
    permission: [],
    options: {},
  }),
  list: () => Effect.succeed([]),
  defaultInfo: () => Effect.succeed({ name: "default", description: "", mode: "primary", permission: [], options: {} }),
  defaultAgent: () => Effect.succeed("default"),
  generate: () => Effect.succeed({ identifier: "gen", whenToUse: "test", systemPrompt: "test" }),
}

const mockCtx: Context = {
  sessionID: "ses_test" as Context["sessionID"],
  messageID: "msg_test" as Context["messageID"],
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_123",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDef(
  params: Schema.Decoder<unknown>,
  executeFn: (args: unknown, ctx: Context) => Effect.Effect<ExecuteResult>,
) {
  return {
    id: "test-tool",
    description: "A test tool",
    parameters: params,
    execute: executeFn,
  }
}

// Build the test layers once
const testLayers = Layer.merge(
  Layer.succeed(Truncate.Service, mockTruncate),
  Layer.succeed(Agent.Service, mockAgent),
)

function runWithTruncate(
  def: ReturnType<typeof makeDef>,
  args: unknown,
  ctx: Context,
  truncate: Truncate.Interface,
): Effect.Effect<ExecuteResult> {
  const layers = Layer.merge(
    Layer.succeed(Truncate.Service, truncate),
    Layer.succeed(Agent.Service, mockAgent),
  )

  const info = defineTool("test-tool", Effect.succeed(def))
  return Effect.gen(function* () {
    const resolved = yield* Effect.provide(info, layers)
    const def2 = yield* Effect.provide(initTool(resolved), layers)
    return yield* def2.execute(args, ctx)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wrap — toolsLog instrumentation", () => {
  beforeEach(() => {
    toolsLogCalls.length = 0
  })

  describe("success path — no truncation", () => {
    test("logs toolsLog with correct fields on success without truncation", () => {
      const def = makeDef(
        Schema.Struct({ command: Schema.String }),
        (args) => Effect.succeed({ title: "ok", metadata: {}, output: "hello" }),
      )

      const result = Effect.runSync(
        Effect.scoped(runWithTruncate(def, { command: "ls" }, mockCtx, mockTruncate)),
      )

      expect(result.output).toBe("hello")
      expect(toolsLogCalls).toHaveLength(1)

      const entry = toolsLogCalls[0]
      expect(entry.tool).toBe("test-tool")
      expect(entry.sessionId).toBe("ses_test")
      expect(entry.messageId).toBe("msg_test")
      expect(entry.callId).toBe("call_123")
      expect(entry.durationMs).toBeGreaterThanOrEqual(0)
      expect(entry.args).toEqual({ command: "ls" })
      expect(entry.output).toBe("hello")
      expect(entry.truncated).toBe(false)
      expect(entry.rawOutputLength).toBeUndefined()
      expect(entry.error).toBeUndefined()
      expect(entry.source).toBe("built-in")
    })
  })

  describe("success path — with truncation", () => {
    test("logs toolsLog with truncated flag and rawOutputLength when output is truncated", () => {
      const def = makeDef(
        Schema.Struct({ command: Schema.String }),
        (args) => Effect.succeed({ title: "ok", metadata: {}, output: "a".repeat(100) }),
      )

      const result = Effect.runSync(
        Effect.scoped(runWithTruncate(def, { command: "ls" }, mockCtx, mockTruncateAlways)),
      )

      expect(result.output).toContain("truncated:")
      expect(toolsLogCalls).toHaveLength(1)

      const entry = toolsLogCalls[0]
      expect(entry.truncated).toBe(true)
      expect(entry.rawOutputLength).toBe(100)
      expect(entry.output).toBeDefined()
      expect(entry.error).toBeUndefined()
    })
  })

  describe("success path — pre-truncated metadata", () => {
    test("logs toolsLog when result.metadata.truncated is already set (skips truncation)", () => {
      const def = makeDef(
        Schema.Struct({ command: Schema.String }),
        (args) => Effect.succeed({ title: "ok", metadata: { truncated: true }, output: "pre-truncated" }),
      )

      const result = Effect.runSync(
        Effect.scoped(runWithTruncate(def, { command: "ls" }, mockCtx, mockTruncate)),
      )

      expect(result.output).toBe("pre-truncated")
      expect(toolsLogCalls).toHaveLength(1)

      const entry = toolsLogCalls[0]
      expect(entry.output).toBe("pre-truncated")
      expect(entry.truncated).toBe(false)
      expect(entry.rawOutputLength).toBeUndefined()
    })
  })

  describe("InvalidArgumentsError — decode failure", () => {
    test("logs toolsLog with error and raw args when decode fails", () => {
      const def = makeDef(
        Schema.Struct({ command: Schema.String }),
        () => Effect.succeed({ title: "ok", metadata: {}, output: "never" }),
      )

      // Pass invalid args (number instead of string for command)
      const exit = Effect.runSyncExit(
        Effect.scoped(
          Effect.sandbox(
            runWithTruncate(def, { command: 42 }, mockCtx, mockTruncate),
          ),
        ),
      )

      // Should have failed — the effect should be a failure
      expect(exit._tag).toBe("Failure")
      expect(toolsLogCalls).toHaveLength(1)

      const entry = toolsLogCalls[0]
      expect(entry.tool).toBe("test-tool")
      expect(entry.sessionId).toBe("ses_test")
      expect(entry.messageId).toBe("msg_test")
      expect(entry.callId).toBe("call_123")
      expect(entry.durationMs).toBeGreaterThanOrEqual(0)
      // Raw args (not decoded) should be logged
      expect(entry.args).toEqual({ command: 42 })
      expect(entry.error).toBeDefined()
      expect(entry.error).toContain("invalid")
      expect(entry.source).toBe("built-in")
      expect(entry.output).toBeUndefined()
    })
  })

  describe("execute error", () => {
    test("logs toolsLog with error when execute throws", () => {
      const def = makeDef(
        Schema.Struct({ command: Schema.String }),
        () => Effect.fail(new Error("execution failed")) as unknown as Effect.Effect<ExecuteResult>,
      )

      const exit = Effect.runSyncExit(
        Effect.scoped(
          Effect.sandbox(
            runWithTruncate(def, { command: "ls" }, mockCtx, mockTruncate),
          ),
        ),
      )

      expect(exit._tag).toBe("Failure")
      expect(toolsLogCalls).toHaveLength(1)

      const entry = toolsLogCalls[0]
      expect(entry.tool).toBe("test-tool")
      expect(entry.sessionId).toBe("ses_test")
      expect(entry.messageId).toBe("msg_test")
      expect(entry.callId).toBe("call_123")
      expect(entry.durationMs).toBeGreaterThanOrEqual(0)
      // Decoded args should be logged (decode succeeded)
      expect(entry.args).toEqual({ command: "ls" })
      expect(entry.error).toBe("execution failed")
      expect(entry.source).toBe("built-in")
      expect(entry.output).toBeUndefined()
    })

    test("logs toolsLog with error when execute throws non-Error", () => {
      const def = makeDef(
        Schema.Struct({ command: Schema.String }),
        () => Effect.fail("string error") as unknown as Effect.Effect<ExecuteResult>,
      )

      const exit = Effect.runSyncExit(
        Effect.scoped(
          Effect.sandbox(
            runWithTruncate(def, { command: "ls" }, mockCtx, mockTruncate),
          ),
        ),
      )

      expect(exit._tag).toBe("Failure")
      expect(toolsLogCalls).toHaveLength(1)

      const entry = toolsLogCalls[0]
      expect(entry.error).toBe("string error")
    })
  })

  describe("no callID", () => {
    test("logs toolsLog with null callId when ctx.callID is absent", () => {
      const ctxWithoutCallID = {
        ...mockCtx,
        callID: undefined,
      }

      const def = makeDef(
        Schema.Struct({ command: Schema.String }),
        (args) => Effect.succeed({ title: "ok", metadata: {}, output: "hello" }),
      )

      Effect.runSync(
        Effect.scoped(
          runWithTruncate(def, { command: "ls" }, ctxWithoutCallID, mockTruncate),
        ),
      )

      expect(toolsLogCalls).toHaveLength(1)
      const entry = toolsLogCalls[0]
      expect(entry.callId).toBeNull()
    })
  })
})

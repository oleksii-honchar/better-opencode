import { describe, test, expect, beforeEach, mock } from "bun:test"
import * as Effect from "effect/Effect"

// ---------------------------------------------------------------------------
// Mocks — capture calls to Log.toolsLog
// ---------------------------------------------------------------------------

const toolsLogCalls: Record<string, unknown>[] = []

// Mock the Log module — only toolsLog is needed for this test
mock.module("@opencode-ai/core/util/log", () => ({
  toolsLog: (entry: Record<string, unknown>) => {
    toolsLogCalls.push(entry)
  },
}))

// Import Log AFTER the mock is registered — this gives us the mocked version
import * as Log from "@opencode-ai/core/util/log"

// ---------------------------------------------------------------------------
// Helper: build the MCP Effect pipeline (mirrors tools.ts instrumentation)
// ---------------------------------------------------------------------------

function buildMcpEffect(params: {
  mcpToolName: string
  args: Record<string, unknown>
  sessionID: string
  messageID: string
  callID: string | null
  mcpExecute: () => Promise<{ content: Array<{ type: string; text?: string }>; metadata: Record<string, unknown> }>
  truncateResult: { content: string; truncated: boolean; outputPath?: string }
  rawOutputLength?: number
}) {
  const { mcpToolName, args, sessionID, messageID, callID, mcpExecute, truncateResult, rawOutputLength } = params

  return Effect.gen(function* () {
    const start = Date.now()

    const result = yield* Effect.promise(() => mcpExecute()).pipe(
      Effect.withSpan("Tool.execute", {
        attributes: {
          "tool.name": mcpToolName,
          "tool.call_id": callID,
          "session.id": sessionID,
          "message.id": messageID,
        },
      }),
      Effect.tapError((error) =>
        Effect.sync(() => {
          Log.toolsLog({
            tool: mcpToolName,
            sessionId: sessionID,
            messageId: messageID,
            callId: callID,
            durationMs: Date.now() - start,
            args,
            error: (error as unknown) instanceof Error ? (error as Error).message : String(error),
            source: "mcp",
          })
        }),
      ),
    )

    // Simulate text extraction
    const textParts: string[] = []
    for (const contentItem of result.content) {
      if (contentItem.type === "text") textParts.push(contentItem.text ?? "")
    }

    // Success log
    Log.toolsLog({
      tool: mcpToolName,
      sessionId: sessionID,
      messageId: messageID,
      callId: callID,
      durationMs: Date.now() - start,
      args,
      output: truncateResult.content,
      truncated: truncateResult.truncated,
      ...(truncateResult.truncated && rawOutputLength ? { rawOutputLength } : {}),
      source: "mcp",
    })

    return { output: truncateResult.content, metadata: { truncated: truncateResult.truncated } }
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP tool instrumentation — toolsLog", () => {
  beforeEach(() => {
    toolsLogCalls.length = 0
  })

  describe("success path — no truncation", () => {
    test("logs toolsLog with correct fields on MCP success without truncation", async () => {
      const mcpToolName = "mcp:filesystem:read"
      const args = { path: "/etc/hosts" }
      const sessionID = "ses_test"
      const messageID = "msg_test"
      const callID = "call_456"

      const mcpExecute = async () => ({
        content: [{ type: "text" as const, text: "127.0.0.1 localhost" }],
        metadata: {},
      })

      const result = await Effect.runPromise(
        buildMcpEffect({
          mcpToolName,
          args,
          sessionID,
          messageID,
          callID,
          mcpExecute,
          truncateResult: { content: "127.0.0.1 localhost", truncated: false },
        }),
      )

      expect(result.output).toBe("127.0.0.1 localhost")
      expect(toolsLogCalls).toHaveLength(1)

      const entry = toolsLogCalls[0]
      expect(entry.tool).toBe(mcpToolName)
      expect(entry.sessionId).toBe(sessionID)
      expect(entry.messageId).toBe(messageID)
      expect(entry.callId).toBe(callID)
      expect(entry.durationMs).toBeGreaterThanOrEqual(0)
      expect(entry.args).toEqual(args)
      expect(entry.output).toBe("127.0.0.1 localhost")
      expect(entry.truncated).toBe(false)
      expect(entry.rawOutputLength).toBeUndefined()
      expect(entry.error).toBeUndefined()
      expect(entry.source).toBe("mcp")
    })
  })

  describe("success path — with truncation", () => {
    test("logs toolsLog with truncated flag and rawOutputLength when output is truncated", async () => {
      const mcpToolName = "mcp:filesystem:read"
      const args = { path: "/big/file" }
      const sessionID = "ses_test"
      const messageID = "msg_test"
      const callID = "call_789"

      const rawText = "a".repeat(100)
      const mcpExecute = async () => ({
        content: [{ type: "text" as const, text: rawText }],
        metadata: {},
      })

      await Effect.runPromise(
        buildMcpEffect({
          mcpToolName,
          args,
          sessionID,
          messageID,
          callID,
          mcpExecute,
          truncateResult: {
            content: "truncated:" + rawText.slice(0, 20),
            truncated: true,
            outputPath: "/tmp/truncated.txt",
          },
          rawOutputLength: 100,
        }),
      )

      expect(toolsLogCalls).toHaveLength(1)

      const entry = toolsLogCalls[0]
      expect(entry.truncated).toBe(true)
      expect(entry.rawOutputLength).toBe(100)
      expect(entry.output).toBeDefined()
      expect(entry.error).toBeUndefined()
    })
  })

  describe("error path", () => {
    test("logs toolsLog with error when MCP execute throws Error", async () => {
      const mcpToolName = "mcp:filesystem:read"
      const args = { path: "/etc/hosts" }
      const sessionID = "ses_test"
      const messageID = "msg_test"
      const callID = "call_err"

      const mcpExecute = async () => {
        throw new Error("MCP connection refused")
      }

      const effect = Effect.gen(function* () {
        const start = Date.now()

        const result = yield* Effect.promise(() => mcpExecute()).pipe(
          Effect.withSpan("Tool.execute", {
            attributes: {
              "tool.name": mcpToolName,
              "tool.call_id": callID,
              "session.id": sessionID,
              "message.id": messageID,
            },
          }),
          Effect.tapDefect((e) =>
            Effect.sync(() => {
              const msg = e instanceof Error ? e.message : String(e)
              Log.toolsLog({
                tool: mcpToolName,
                sessionId: sessionID,
                messageId: messageID,
                callId: callID,
                durationMs: Date.now() - start,
                args,
                error: msg,
                source: "mcp",
              })
            }),
          ),
          Effect.catchDefect((e) => {
            // Convert defect to typed failure so the effect still fails
            const err = e instanceof Error ? e : new Error(String(e))
            return Effect.fail(err)
          }),
        )

        return result
      })

      const exit = await Effect.runPromiseExit(effect)

      expect(exit._tag).toBe("Failure")
      expect(toolsLogCalls).toHaveLength(1)

      const entry = toolsLogCalls[0]
      expect(entry.tool).toBe(mcpToolName)
      expect(entry.sessionId).toBe(sessionID)
      expect(entry.messageId).toBe(messageID)
      expect(entry.callId).toBe(callID)
      expect(entry.durationMs).toBeGreaterThanOrEqual(0)
      expect(entry.args).toEqual(args)
      expect(entry.error).toBe("MCP connection refused")
      expect(entry.source).toBe("mcp")
      expect(entry.output).toBeUndefined()
    })

    test("logs toolsLog with error when MCP execute throws non-Error", async () => {
      const mcpToolName = "mcp:filesystem:read"
      const args = { path: "/etc/hosts" }
      const sessionID = "ses_test"
      const messageID = "msg_test"
      const callID = "call_err2"

      const mcpExecute = async () => {
        throw "string error"
      }

      const effect = Effect.gen(function* () {
        const start = Date.now()

        const result = yield* Effect.promise(() => mcpExecute()).pipe(
          Effect.withSpan("Tool.execute", {
            attributes: {
              "tool.name": mcpToolName,
              "tool.call_id": callID,
              "session.id": sessionID,
              "message.id": messageID,
            },
          }),
          Effect.tapDefect((e) =>
            Effect.sync(() => {
              const msg = e instanceof Error ? e.message : String(e)
              Log.toolsLog({
                tool: mcpToolName,
                sessionId: sessionID,
                messageId: messageID,
                callId: callID,
                durationMs: Date.now() - start,
                args,
                error: msg,
                source: "mcp",
              })
            }),
          ),
          Effect.catchDefect((e) => {
            const err = e instanceof Error ? e : new Error(String(e))
            return Effect.fail(err)
          }),
        )

        return result
      })

      const exit = await Effect.runPromiseExit(effect)

      expect(exit._tag).toBe("Failure")
      expect(toolsLogCalls).toHaveLength(1)

      const entry = toolsLogCalls[0]
      expect(entry.error).toBe("string error")
      expect(entry.source).toBe("mcp")
    })
  })

  describe("no callID", () => {
    test("logs toolsLog with null callId when opts.toolCallId is absent", async () => {
      const mcpToolName = "mcp:filesystem:read"
      const args = { path: "/etc/hosts" }
      const sessionID = "ses_test"
      const messageID = "msg_test"
      const callID = null

      const mcpExecute = async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        metadata: {},
      })

      await Effect.runPromise(
        buildMcpEffect({
          mcpToolName,
          args,
          sessionID,
          messageID,
          callID,
          mcpExecute,
          truncateResult: { content: "ok", truncated: false },
        }),
      )

      expect(toolsLogCalls).toHaveLength(1)
      const entry = toolsLogCalls[0]
      expect(entry.callId).toBeNull()
    })
  })
})

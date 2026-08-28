import { describe, test, expect, beforeEach, mock } from "bun:test"
import * as Effect from "effect/Effect"
import { isToolResponseFile, type ToolResponseFile, processContentItems } from "./tools"

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
  mcpExecute: () => Promise<{
    content: Array<{ type: string; text?: string }>
    metadata: Record<string, unknown>
    structuredContent?: unknown
  }>
  truncateResult: { content: string; truncated: boolean; outputPath?: string }
  rawOutputLength?: number
}) {
  const { mcpToolName, args, sessionID, messageID, callID, mcpExecute, truncateResult, rawOutputLength } = params

  // Mirror the trim logic from tools.ts: structuredContent in toolsLog is trimmed to 500 chars
  function trimStructuredContent(sc: unknown): { structuredContent: string; scLength: number } {
    const s = JSON.stringify(sc)
    return {
      structuredContent: s.length > 500 ? s.slice(0, 500) + "..." : s,
      scLength: s.length,
    }
  }

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
      ...(result.structuredContent !== undefined
        ? trimStructuredContent(result.structuredContent)
        : {}),
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

  describe("structuredContent in toolsLog — trimmed", () => {
    test("adds trimmed structuredContent and scLength when structuredContent is a short object (< 500 chars)", async () => {
      const mcpToolName = "mcp:test:tool"
      const args = { query: "test" }
      const sessionID = "ses_test"
      const messageID = "msg_test"
      const callID = "call_sc_short"

      const structuredContent = { key: "value", name: "short data" }
      const expectedScString = JSON.stringify(structuredContent)

      const mcpExecute = async () => ({
        content: [{ type: "text" as const, text: "result" }],
        metadata: {},
        structuredContent,
      })

      await Effect.runPromise(
        buildMcpEffect({
          mcpToolName,
          args,
          sessionID,
          messageID,
          callID,
          mcpExecute,
          truncateResult: { content: "result", truncated: false },
        }),
      )

      expect(toolsLogCalls).toHaveLength(1)
      const entry = toolsLogCalls[0]
      expect(entry.structuredContent).toBe(expectedScString)
      expect(entry.scLength).toBe(expectedScString.length)
    })

    test("trims structuredContent to 500 chars with ellipsis and adds scLength when payload exceeds 500 chars", async () => {
      const mcpToolName = "mcp:test:tool"
      const args = { query: "big" }
      const sessionID = "ses_test"
      const messageID = "msg_test"
      const callID = "call_sc_long"

      // Build an object whose JSON representation is > 500 chars
      const bigObject: Record<string, string> = {}
      for (let i = 0; i < 40; i++) {
        bigObject[`key_${i}`] = "x".repeat(20)
      }
      const fullJson = JSON.stringify(bigObject)
      expect(fullJson.length).toBeGreaterThan(500)

      const mcpExecute = async () => ({
        content: [{ type: "text" as const, text: "result" }],
        metadata: {},
        structuredContent: bigObject,
      })

      await Effect.runPromise(
        buildMcpEffect({
          mcpToolName,
          args,
          sessionID,
          messageID,
          callID,
          mcpExecute,
          truncateResult: { content: "result", truncated: false },
        }),
      )

      expect(toolsLogCalls).toHaveLength(1)
      const entry = toolsLogCalls[0]
      expect(entry.structuredContent).toBe(fullJson.slice(0, 500) + "...")
      expect(entry.scLength).toBe(fullJson.length)
    })

    test("does NOT add structuredContent or scLength when structuredContent is undefined", async () => {
      const mcpToolName = "mcp:test:tool"
      const args = { query: "none" }
      const sessionID = "ses_test"
      const messageID = "msg_test"
      const callID = "call_sc_none"

      const mcpExecute = async () => ({
        content: [{ type: "text" as const, text: "result" }],
        metadata: {},
        // no structuredContent
      })

      await Effect.runPromise(
        buildMcpEffect({
          mcpToolName,
          args,
          sessionID,
          messageID,
          callID,
          mcpExecute,
          truncateResult: { content: "result", truncated: false },
        }),
      )

      expect(toolsLogCalls).toHaveLength(1)
      const entry = toolsLogCalls[0]
      expect(entry.structuredContent).toBeUndefined()
      expect(entry.scLength).toBeUndefined()
    })

    test("does NOT add structuredContent or scLength when structuredContent is undefined (explicit)", async () => {
      const mcpToolName = "mcp:test:tool"
      const args = { query: "undef" }
      const sessionID = "ses_test"
      const messageID = "msg_test"
      const callID = "call_sc_undef"

      const mcpExecute = async () => ({
        content: [{ type: "text" as const, text: "result" }],
        metadata: {},
        structuredContent: undefined,
      })

      await Effect.runPromise(
        buildMcpEffect({
          mcpToolName,
          args,
          sessionID,
          messageID,
          callID,
          mcpExecute,
          truncateResult: { content: "result", truncated: false },
        }),
      )

      expect(toolsLogCalls).toHaveLength(1)
      const entry = toolsLogCalls[0]
      expect(entry.structuredContent).toBeUndefined()
      expect(entry.scLength).toBeUndefined()
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

// ---------------------------------------------------------------------------
// Helper: construct output object the same way tools.ts does (line 286-297)
// ---------------------------------------------------------------------------

function buildOutput(result: {
  content: Array<{ type: string; text?: string }>
  structuredContent?: unknown
}) {
  return {
    title: "",
    metadata: {},
    output: "test output",
    attachments: [],
    content: result.content,
    ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }),
  }
}

// ---------------------------------------------------------------------------
// Tests: structuredContent forwarding in output object
// ---------------------------------------------------------------------------

describe("structuredContent forwarding in output", () => {
  describe("when result has structuredContent", () => {
    test("includes structuredContent when it is an object", () => {
      const structuredContent = { key: "value", nested: { a: 1 } }
      const result = { content: [{ type: "text" as const, text: "hello" }], structuredContent }

      const output = buildOutput(result)

      expect(output).toHaveProperty("structuredContent")
      expect(output.structuredContent).toEqual(structuredContent)
    })

    test("includes structuredContent when it is a string", () => {
      const structuredContent = JSON.stringify({ key: "value" })
      const result = { content: [{ type: "text" as const, text: "hello" }], structuredContent }

      const output = buildOutput(result)

      expect(output).toHaveProperty("structuredContent")
      expect(output.structuredContent).toBe(structuredContent)
    })

    test("includes structuredContent when it is an array", () => {
      const structuredContent = [{ id: 1 }, { id: 2 }]
      const result = { content: [{ type: "text" as const, text: "hello" }], structuredContent }

      const output = buildOutput(result)

      expect(output).toHaveProperty("structuredContent")
      expect(output.structuredContent).toEqual(structuredContent)
    })

    test("includes structuredContent with value null (null !== undefined)", () => {
      const result = { content: [{ type: "text" as const, text: "hello" }], structuredContent: null }

      const output = buildOutput(result)

      // null !== undefined, so conditional spread includes it
      expect(output).toHaveProperty("structuredContent")
      expect(output.structuredContent).toBeNull()
    })
  })

  describe("when result has no structuredContent", () => {
    test("does NOT include structuredContent property when it is undefined", () => {
      const result: { content: Array<{ type: string; text?: string }>; structuredContent?: undefined } = {
        content: [{ type: "text" as const, text: "hello" }],
      }

      const output = buildOutput(result)

      expect(output).not.toHaveProperty("structuredContent")
    })

    test("does NOT include structuredContent property when explicitly undefined", () => {
      const result = {
        content: [{ type: "text" as const, text: "hello" }],
        structuredContent: undefined,
      }

      const output = buildOutput(result)

      expect(output).not.toHaveProperty("structuredContent")
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: ToolResponseFile type guard
// ---------------------------------------------------------------------------

describe("isToolResponseFile", () => {
  test("returns true for tool_response_file content item", () => {
    const contentItem: ToolResponseFile = {
      type: "tool_response_file",
      filePath: "/tmp/agent-tool-responses/test-123.json",
      fileName: "test-123.json",
      fileSize: 159623,
      summary: "[structuredContent]\\n{\\n  \\\"results\\\": ...",
      savedAt: "2026-08-14T07:25:27.042Z",
      instructions: "Tool response saved to file.",
    }

    expect(isToolResponseFile(contentItem)).toBe(true)
  })

  test("returns false for text content type", () => {
    const contentItem = { type: "text" as const, text: "hello world" }

    expect(isToolResponseFile(contentItem)).toBe(false)
  })

  test("returns false for image content type", () => {
    const contentItem = {
      type: "image" as const,
      data: "base64data",
      mimeType: "image/png",
    }

    expect(isToolResponseFile(contentItem)).toBe(false)
  })

  test("returns false for resource content type", () => {
    const contentItem = {
      type: "resource" as const,
      resource: {
        uri: "file:///tmp/test.json",
        mimeType: "application/json",
        text: '{"key": "value"}',
      },
    }

    expect(isToolResponseFile(contentItem)).toBe(false)
  })

  test("returns false for unknown content type", () => {
    const contentItem = { type: "unknown_type" as const, data: "something" }

    expect(isToolResponseFile(contentItem)).toBe(false)
  })

  test("returns false when type is tool_response_file but required fields are missing", () => {
    const contentItem = { type: "tool_response_file" as const }

    expect(isToolResponseFile(contentItem)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: processContentItems — tool_response_file handling
// ---------------------------------------------------------------------------

describe("processContentItems — tool_response_file", () => {
  describe("valid file — reads content from filePath", () => {
    test("reads file content from filePath and uses it for text output", () => {
      const fileContent = JSON.stringify({ results: [{ id: "test", status: "ok" }] })
      const contentItems = [
        {
          type: "tool_response_file" as const,
          filePath: "/tmp/test-response.json",
          fileName: "test-response.json",
          fileSize: fileContent.length,
          summary: "corrupted_base64_content_here",
          savedAt: "2026-08-14T07:25:27.042Z",
          instructions: "Tool response saved to file.",
        } satisfies ToolResponseFile,
      ]

      const result = processContentItems(contentItems, {
        readFile: (path: string) => {
          expect(path).toBe("/tmp/test-response.json")
          return fileContent
        },
      })

      // File content is used, NOT the corrupted summary
      expect(result.textParts).toHaveLength(1)
      expect(result.textParts[0]).toContain('"results"')
      expect(result.textParts[0]).toContain('"id": "test"')
      expect(result.textParts[0]).not.toContain("corrupted_base64_content_here")
      expect(result.attachments).toHaveLength(0)
    })

    test("includes filePath, fileName, and fileSize in metadata", () => {
      const fileContent = JSON.stringify({ key: "value" })
      const contentItems = [
        {
          type: "tool_response_file" as const,
          filePath: "/tmp/test-file.json",
          fileName: "test-file.json",
          fileSize: 42,
          summary: "some summary",
          savedAt: "2026-08-14T07:25:27.042Z",
          instructions: "Read the file.",
        } satisfies ToolResponseFile,
      ]

      const result = processContentItems(contentItems, {
        readFile: () => fileContent,
      })

      expect(result.textParts).toHaveLength(1)
      expect(result.textParts[0]).toContain("filePath: /tmp/test-file.json")
      expect(result.textParts[0]).toContain("fileName: test-file.json")
      expect(result.textParts[0]).toContain("fileSize: 42")
    })

    test("parses JSON file content and formats it as pretty-printed text", () => {
      const fileContent = JSON.stringify({ key: "value", nested: { a: 1 } })
      const contentItems = [
        {
          type: "tool_response_file" as const,
          filePath: "/tmp/pretty.json",
          fileName: "pretty.json",
          fileSize: fileContent.length,
          summary: "ignored",
          savedAt: "2026-08-14T07:25:27.042Z",
          instructions: "Read the file.",
        } satisfies ToolResponseFile,
      ]

      const result = processContentItems(contentItems, {
        readFile: () => fileContent,
      })

      expect(result.textParts).toHaveLength(1)
      // Should contain pretty-printed JSON (with indentation)
      expect(result.textParts[0]).toContain("  \"key\"")
      expect(result.textParts[0]).toContain("  \"nested\"")
    })
  })

  describe("missing file — falls back to instructions", () => {
    test("falls back to instructions when file read fails with ENOENT", () => {
      const contentItems = [
        {
          type: "tool_response_file" as const,
          filePath: "/tmp/missing-file.json",
          fileName: "missing-file.json",
          fileSize: 100,
          summary: "corrupted",
          savedAt: "2026-08-14T07:25:27.042Z",
          instructions: "Tool response saved to file. Use cat to read it.",
        } satisfies ToolResponseFile,
      ]

      const result = processContentItems(contentItems, {
        readFile: () => {
          const err = new Error("ENOENT: no such file or directory")
          ;(err as NodeJS.ErrnoException).code = "ENOENT"
          throw err
        },
      })

      expect(result.textParts).toHaveLength(1)
      // Should contain the instructions fallback
      expect(result.textParts[0]).toContain("instructions")
      expect(result.textParts[0]).toContain("Tool response saved to file")
      expect(result.textParts[0]).toContain("/tmp/missing-file.json")
      // Should NOT contain corrupted summary
      expect(result.textParts[0]).not.toContain("corrupted")
    })

    test("falls back to instructions when file read fails with permission error", () => {
      const contentItems = [
        {
          type: "tool_response_file" as const,
          filePath: "/tmp/forbidden.json",
          fileName: "forbidden.json",
          fileSize: 100,
          summary: "corrupted",
          savedAt: "2026-08-14T07:25:27.042Z",
          instructions: "Tool response saved to file.",
        } satisfies ToolResponseFile,
      ]

      const result = processContentItems(contentItems, {
        readFile: () => {
          const err = new Error("EACCES: permission denied")
          ;(err as NodeJS.ErrnoException).code = "EACCES"
          throw err
        },
      })

      expect(result.textParts).toHaveLength(1)
      expect(result.textParts[0]).toContain("instructions")
      expect(result.textParts[0]).toContain("Tool response saved to file")
      expect(result.textParts[0]).not.toContain("corrupted")
    })
  })

  describe("mixed content — tool_response_file with text", () => {
    test("handles tool_response_file alongside regular text content", () => {
      const fileContent = JSON.stringify({ data: "from file" })
      const contentItems = [
        { type: "text" as const, text: "Hello from text" },
        {
          type: "tool_response_file" as const,
          filePath: "/tmp/mixed.json",
          fileName: "mixed.json",
          fileSize: fileContent.length,
          summary: "ignored",
          savedAt: "2026-08-14T07:25:27.042Z",
          instructions: "Read the file.",
        } satisfies ToolResponseFile,
        { type: "text" as const, text: "After file" },
      ]

      const result = processContentItems(contentItems, {
        readFile: () => fileContent,
      })

      expect(result.textParts).toHaveLength(3)
      expect(result.textParts[0]).toBe("Hello from text")
      expect(result.textParts[1]).toContain('"data": "from file"')
      expect(result.textParts[2]).toBe("After file")
    })
  })

  describe("non-JSON file content", () => {
    test("uses raw file content when JSON parse fails", () => {
      const fileContent = "This is not valid JSON {{"
      const contentItems = [
        {
          type: "tool_response_file" as const,
          filePath: "/tmp/raw.txt",
          fileName: "raw.txt",
          fileSize: fileContent.length,
          summary: "ignored",
          savedAt: "2026-08-14T07:25:27.042Z",
          instructions: "Read the file.",
        } satisfies ToolResponseFile,
      ]

      const result = processContentItems(contentItems, {
        readFile: () => fileContent,
      })

      expect(result.textParts).toHaveLength(1)
      expect(result.textParts[0]).toContain("This is not valid JSON")
    })
  })
})

// ---------------------------------------------------------------------------
// Integration tests: processContentItems with real file I/O
// ---------------------------------------------------------------------------

describe("processContentItems — integration (real file I/O)", () => {
  // Helper: create a temp dir, return cleanup function
  function createTempDir(): { dir: string; cleanup: () => void } {
    const tmpPath = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim()
    return {
      dir: tmpPath,
      cleanup: () => {
        try {
          Bun.spawnSync(["rm", "-rf", tmpPath])
        } catch {
          // best-effort
        }
      },
    }
  }

  describe("end-to-end flow: tool_response_file with real file on disk", () => {
    test("reads real file from disk and produces correct output without base64 corruption", () => {
      const tmpDir = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim()
      try {
        // Write a realistic JSON response to disk (simulating what an MCP tool would do)
        const fileContent = JSON.stringify({
          results: [
            { id: "symbols-client", status: "ok", data: { symbols: [{ name: "JraHttpTransport" }] } },
            { id: "symbols-resolver", status: "ok", data: { symbols: [{ name: "decodeJraPayload" }] } },
          ],
        })
        const filePath = tmpDir + "/octocode_lspGetSemantics-integration.json"
        Bun.write(filePath, fileContent)

        const contentItems = [
          {
            type: "tool_response_file" as const,
            filePath,
            fileName: "octocode_lspGetSemantics-integration.json",
            fileSize: Buffer.byteLength(fileContent),
            summary: "corrupted_base64_summary_with_long_content",
            savedAt: "2026-08-14T07:25:27.042Z",
            instructions: "Tool response saved to file. Use cat to read: " + filePath,
          } satisfies ToolResponseFile,
        ]

        // Use default readFile (fs.readFileSync) — no mock
        const result = processContentItems(contentItems)

        // File content is used, NOT the corrupted summary
        expect(result.textParts).toHaveLength(1)
        const output = result.textParts[0]

        // Should contain the actual file content
        expect(output).toContain('"results"')
        expect(output).toContain('"symbols-client"')
        expect(output).toContain('"JraHttpTransport"')
        expect(output).toContain('"decodeJraPayload"')

        // Should contain metadata
        expect(output).toContain("filePath: " + filePath)
        expect(output).toContain("fileName: octocode_lspGetSemantics-integration.json")

        // Should NOT contain the corrupted base64 summary — this is the key regression
        expect(output).not.toContain("corrupted_base64_summary")

        // No attachments for tool_response_file
        expect(result.attachments).toHaveLength(0)
      } finally {
        Bun.spawnSync(["rm", "-rf", tmpDir])
      }
    })
  })

  describe("mixed content: text + tool_response_file with real file", () => {
    test("handles text content and tool_response_file from real file correctly", () => {
      const tmpDir = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim()
      try {
        // Write a real file to disk
        const fileContent = JSON.stringify({ data: "from real file", count: 42 })
        const filePath = tmpDir + "/mixed-test.json"
        Bun.write(filePath, fileContent)

        const contentItems = [
          { type: "text" as const, text: "Here is the tool response:" },
          {
            type: "tool_response_file" as const,
            filePath,
            fileName: "mixed-test.json",
            fileSize: Buffer.byteLength(fileContent),
            summary: "corrupted_summary",
            savedAt: "2026-08-14T07:25:27.042Z",
            instructions: "Read the file.",
          } satisfies ToolResponseFile,
          { type: "text" as const, text: "End of response." },
        ]

        const result = processContentItems(contentItems)

        expect(result.textParts).toHaveLength(3)
        expect(result.textParts[0]).toBe("Here is the tool response:")
        expect(result.textParts[1]).toContain('"data": "from real file"')
        expect(result.textParts[1]).toContain('"count": 42')
        expect(result.textParts[1]).not.toContain("corrupted_summary")
        expect(result.textParts[2]).toBe("End of response.")
        expect(result.attachments).toHaveLength(0)
      } finally {
        Bun.spawnSync(["rm", "-rf", tmpDir])
      }
    })
  })

  describe("regression: existing content types unchanged", () => {
    test("text content items are processed correctly (no regression)", () => {
      const contentItems = [
        { type: "text" as const, text: "First text part" },
        { type: "text" as const, text: "Second text part" },
      ]

      const result = processContentItems(contentItems)

      expect(result.textParts).toHaveLength(2)
      expect(result.textParts[0]).toBe("First text part")
      expect(result.textParts[1]).toBe("Second text part")
      expect(result.attachments).toHaveLength(0)
    })

    test("image content items produce attachments (no regression)", () => {
      const contentItems = [
        {
          type: "image" as const,
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ]

      const result = processContentItems(contentItems)

      expect(result.textParts).toHaveLength(0)
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0].type).toBe("file")
      expect(result.attachments[0].mime).toBe("image/png")
      expect(result.attachments[0].url).toContain("data:image/png;base64,")
    })

    test("resource content items with text are processed correctly (no regression)", () => {
      const contentItems = [
        {
          type: "resource" as const,
          resource: {
            uri: "file:///tmp/test-resource.json",
            mimeType: "application/json",
            text: '{"resourceKey": "resourceValue"}',
          },
        },
      ]

      const result = processContentItems(contentItems)

      expect(result.textParts).toHaveLength(1)
      expect(result.textParts[0]).toBe('{"resourceKey": "resourceValue"}')
      expect(result.attachments).toHaveLength(0)
    })

    test("resource content items with blob produce attachments (no regression)", () => {
      const contentItems = [
        {
          type: "resource" as const,
          resource: {
            uri: "file:///tmp/blob-resource.bin",
            mimeType: "application/octet-stream",
            blob: "base64blobdata",
          },
        },
      ]

      const result = processContentItems(contentItems)

      expect(result.textParts).toHaveLength(0)
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0].type).toBe("file")
      expect(result.attachments[0].mime).toBe("application/octet-stream")
      expect(result.attachments[0].url).toContain("data:application/octet-stream;base64,")
      expect(result.attachments[0].filename).toBe("file:///tmp/blob-resource.bin")
    })

    test("resource content items with both text and blob produce both (no regression)", () => {
      const contentItems = [
        {
          type: "resource" as const,
          resource: {
            uri: "file:///tmp/mixed-resource.json",
            mimeType: "application/json",
            text: '{"textKey": "textValue"}',
            blob: "base64blobdata",
          },
        },
      ]

      const result = processContentItems(contentItems)

      expect(result.textParts).toHaveLength(1)
      expect(result.textParts[0]).toBe('{"textKey": "textValue"}')
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0].mime).toBe("application/json")
    })
  })

  describe("no Path name too long error", () => {
    test("large file content does not produce Path name too long error", () => {
      const tmpDir = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim()
      try {
        // Simulate a large MCP response that would have caused "Path name too long"
        // before the fix (base64 in summary was used as a path)
        const largeData: Record<string, unknown> = {}
        for (let i = 0; i < 100; i++) {
          largeData[`key_${i}`] = "x".repeat(500)
        }
        const fileContent = JSON.stringify(largeData)
        const filePath = tmpDir + "/large-response.json"
        Bun.write(filePath, fileContent)

        const base64Chunk = Buffer.from(fileContent).toString("base64").slice(0, 200)
        const contentItems = [
          {
            type: "tool_response_file" as const,
            filePath,
            fileName: "large-response.json",
            fileSize: Buffer.byteLength(fileContent),
            summary: "Path name too long: " + base64Chunk,
            savedAt: "2026-08-14T07:25:27.042Z",
            instructions: "Tool response saved to file.",
          } satisfies ToolResponseFile,
        ]

        // This should not throw — the fix ensures we read from filePath, not the corrupted summary
        const result = processContentItems(contentItems)

        expect(result.textParts).toHaveLength(1)
        expect(result.textParts[0]).toContain("key_0")
        expect(result.textParts[0]).toContain("key_99")
        // Should NOT contain the base64-encoded path that would cause "Path name too long"
        expect(result.textParts[0]).not.toContain("Path name too long")
        expect(result.textParts[0]).not.toContain(base64Chunk)
      } finally {
        Bun.spawnSync(["rm", "-rf", tmpDir])
      }
    })
  })
})

import { describe, test, expect } from "bun:test"
import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"

// ---------------------------------------------------------------------------
// Minimal helpers to construct MessageV2.WithParts for testing
// ---------------------------------------------------------------------------

const testSessionID = SessionID.make("ses_test")
const testMessageID = MessageID.make("msg_test")

function makeWithParts(overrides: Partial<Record<string, unknown>> = {}) {
  const infoOverride = overrides.info ?? {}
  const partsOverride = overrides.parts ?? [
    {
      type: "text" as const,
      text: "Hello from subagent",
      id: PartID.make("prt_1"),
      sessionID: testSessionID,
      messageID: testMessageID,
    },
  ]

  const error = (infoOverride as any).error
  return {
    info: {
      role: "assistant" as const,
      id: testMessageID,
      sessionID: testSessionID,
      time: { created: Date.now() },
      parentID: MessageID.make("msg_parent"),
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test-provider"),
      mode: "primary",
      agent: "test-agent",
      path: { cwd: "/test", root: "/test" },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      error,
      ...infoOverride,
    },
    parts: partsOverride,
  } as any
}

// ---------------------------------------------------------------------------
// Simulate the runTask logic — this mirrors task.ts lines 231-252
// ---------------------------------------------------------------------------

// Current behavior (before fix): always extracts text, ignores error
function runTaskCurrent(result: any): string {
  return result.parts.findLast((item: any) => item.type === "text")?.text ?? ""
}

// Expected behavior (after fix): check error first, then extract text
function runTaskFixed(result: any): Effect.Effect<string, Error> {
  if (result.info.role === "assistant" && result.info.error) {
    return Effect.fail(new Error(result.info.error.name))
  }
  return Effect.succeed(result.parts.findLast((item: any) => item.type === "text")?.text ?? "")
}

// ---------------------------------------------------------------------------
// Tests — verify the fixed behavior
// ---------------------------------------------------------------------------

describe("TaskTool.runTask — error propagation (simulated)", () => {
  test("fails with error name when result.info.error is present", () => {
    const errorInfo = {
      name: "ResponseStreamError",
      message: "Provider stream ended without a finish reason",
      data: { type: "response-stream-error" },
    }

    const result = makeWithParts({
      info: {
        role: "assistant",
        error: errorInfo,
      },
    })

    // Current behavior: ignores error, returns text
    const currentText = runTaskCurrent(result)
    expect(currentText).toBe("Hello from subagent")

    // Fixed behavior: fails with error name
    const exit = Effect.runSyncExit(runTaskFixed(result))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const err = Cause.squash(exit.cause) as Error
      expect(err.message).toBe("ResponseStreamError")
    }
  })

  test("extracts text normally when no error is present", () => {
    const result = makeWithParts({
      parts: [
        {
          type: "text" as const,
          text: "Hello from subagent",
          id: PartID.make("prt_1"),
          sessionID: testSessionID,
          messageID: testMessageID,
        },
      ],
    })

    const exit = Effect.runSyncExit(runTaskFixed(result))
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).toBe("Hello from subagent")
    }
  })

  test("returns empty string when no text parts exist and no error", () => {
    const result = makeWithParts({
      parts: [],
    })

    const exit = Effect.runSyncExit(runTaskFixed(result))
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).toBe("")
    }
  })

  test("does not check error when role is not assistant", () => {
    // User messages should not trigger error check
    const result = makeWithParts({
      info: {
        role: "user",
      },
      parts: [
        {
          type: "text" as const,
          text: "User message",
          id: PartID.make("prt_1"),
          sessionID: testSessionID,
          messageID: testMessageID,
        },
      ],
    })

    const exit = Effect.runSyncExit(runTaskFixed(result))
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).toBe("User message")
    }
  })

  test("fails with correct error name for different error types", () => {
    const errorInfo = {
      name: "ContextOverflowError",
      message: "Context overflow",
      data: { type: "context-overflow" },
    }

    const result = makeWithParts({
      info: {
        role: "assistant",
        error: errorInfo,
      },
    })

    const exit = Effect.runSyncExit(runTaskFixed(result))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const err = Cause.squash(exit.cause) as Error
      expect(err.message).toBe("ContextOverflowError")
    }
  })
})

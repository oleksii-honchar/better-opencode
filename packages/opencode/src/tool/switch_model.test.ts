import { describe, test, expect, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionID, MessageID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Interface as EventV2Interface } from "@opencode-ai/core/event"
import { Tool, init as toolInit } from "@/tool/tool"
import type { Interface as TruncateInterface } from "./truncate"
import { Service as TruncateService } from "./truncate"
import { SwitchModelTool } from "./switch_model"

// ---------------------------------------------------------------------------
// Mock service state
// ---------------------------------------------------------------------------

let updateMessageCalls: any[] = []
let setModelCalls: { sessionID: SessionID; model: { providerID: ProviderID; modelID: ModelID } }[] = []
let setModelOverrideCalls: { sessionID: SessionID; model: { providerID: ProviderID; modelID: ModelID } }[] = []
let publishedEvents: { event: any; data: any }[] = []
let getModelCalls: { providerID: ProviderID; modelID: ModelID }[] = []
let getModelShouldFail: { suggestions?: string[] } | null = null

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testSessionID = SessionID.make("ses_test_switch")
const testMessageID = MessageID.make("msg_test_switch")

function makeUserMsg(providerID: ProviderID = ProviderID.make("p1"), modelID: ModelID = ModelID.make("fast")) {
  return {
    info: {
      role: "user" as const,
      id: MessageID.make("msg_user_1"),
      sessionID: testSessionID,
      time: { created: Date.now() },
      agent: "test-agent",
      model: { providerID, modelID },
    },
    parts: [],
  } as any
}

function makeAssistantMsg() {
  return {
    info: {
      role: "assistant" as const,
      id: MessageID.make("msg_assist_1"),
      sessionID: testSessionID,
      time: { created: Date.now() + 1 },
      parentID: MessageID.make("msg_user_1"),
      modelID: ModelID.make("fast"),
      providerID: ProviderID.make("p1"),
      mode: "primary",
      agent: "test-agent",
      path: { cwd: "/test", root: "/test" },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [],
  } as any
}

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

function createMockSessionService() {
  return {
    updateMessage: (msg: any) => {
      updateMessageCalls.push(msg)
      return Effect.succeed(msg)
    },
    setModel: (sessionID: SessionID, model: { providerID: ProviderID; modelID: ModelID }) => {
      setModelCalls.push({ sessionID, model })
      return Effect.void
    },
    setModelOverride: (sessionID: SessionID, model: { providerID: ProviderID; modelID: ModelID }) => {
      setModelOverrideCalls.push({ sessionID, model })
      return Effect.void
    },
  } as unknown as Session.Interface
}

function createMockAgentService(agentInfo: Partial<Agent.Info> = {}) {
  return {
    get: (_name: string) => Effect.succeed(agentInfo as Agent.Info),
  } as unknown as Agent.Interface
}

function createMockProviderService() {
  return {
    getModel: (providerID: ProviderID, modelID: ModelID) => {
      getModelCalls.push({ providerID, modelID })
      if (getModelShouldFail) {
        return Effect.fail(
          new Provider.ModelNotFoundError({
            providerID,
            modelID,
            suggestions: getModelShouldFail.suggestions,
          })
        )
      }
      return Effect.succeed({
        id: modelID,
        providerID,
        name: "Test Model",
      } as any)
    },
  } as unknown as Provider.Interface
}

function createMockEventBridge() {
  return {
    publish: (event: any, data: any) => {
      publishedEvents.push({ event, data })
      return Effect.succeed(event)
    },
    publishEvent: (event: any) => Effect.succeed(event),
    subscribe: () => Effect.void,
    all: () => Effect.void,
    sync: () => Effect.succeed(() => {}),
  } as unknown as EventV2Interface
}

const mockTruncate: TruncateInterface = {
  cleanup: () => Effect.void,
  write: (text) => Effect.succeed(text),
  output: (text) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
}

function makeContext(overrides: Partial<Tool.Context> = {}): Tool.Context {
  return {
    sessionID: testSessionID,
    messageID: testMessageID,
    agent: "test-agent",
    abort: new AbortController().signal,
    messages: [makeUserMsg(), makeAssistantMsg()],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    ...overrides,
  } as any
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

function executeTool(
  params: { model: string; persist?: boolean },
  ctx: Tool.Context,
  agentInfo: Partial<Agent.Info>
) {
  // Create fresh mocks for each test
  const sessionService = createMockSessionService()
  const agentService = createMockAgentService(agentInfo)
  const providerService = createMockProviderService()
  const eventBridge = createMockEventBridge()

  return Effect.gen(function* () {
    const info = yield* SwitchModelTool
    const def = yield* toolInit(info)
    return yield* def.execute(params as any, ctx)
  }).pipe(
    Effect.provideService(Session.Service, sessionService),
    Effect.provideService(Agent.Service, agentService),
    Effect.provideService(Provider.Service, providerService),
    Effect.provideService(EventV2Bridge.Service, eventBridge),
    Effect.provideService(TruncateService, mockTruncate),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SwitchModelTool", () => {
  beforeEach(() => {
    updateMessageCalls = []
    setModelCalls = []
    setModelOverrideCalls = []
    publishedEvents = []
    getModelCalls = []
    getModelShouldFail = null
  })

  test("successful switch: updates message, sets session model, publishes event, returns confirmation", async () => {
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const effect = executeTool(
      { model: "p1/smart" },
      makeContext(),
      agentInfo
    )

    const result = await Effect.runPromise(effect)

    // Returns confirmation containing the model reference
    expect(result.output).toContain("p1/smart")

    // Last user message model is updated
    expect(updateMessageCalls).toHaveLength(1)
    expect(updateMessageCalls[0].model.providerID).toBe(ProviderID.make("p1"))
    expect(updateMessageCalls[0].model.modelID).toBe(ModelID.make("smart"))

    // Session row model is set
    expect(setModelCalls).toHaveLength(1)
    expect(setModelCalls[0].model.providerID).toBe(ProviderID.make("p1"))
    expect(setModelCalls[0].model.modelID).toBe(ModelID.make("smart"))

    // ModelSwitched event is published with correct payload
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0].data.sessionID).toBe(testSessionID)
    expect(publishedEvents[0].data.model.id).toBe(ModelV2.ID.make("smart"))
    expect(publishedEvents[0].data.model.providerID).toBe(ProviderV2.ID.make("p1"))

    // getModel called for validation
    expect(getModelCalls).toHaveLength(1)
    expect(getModelCalls[0].providerID).toBe(ProviderID.make("p1"))
    expect(getModelCalls[0].modelID).toBe(ModelID.make("smart"))
  })

  test("cross-provider rejection: error lists allowed candidates", async () => {
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const effect = executeTool(
      { model: "p2/smart" },
      makeContext(),
      agentInfo
    )

    const exit = await Effect.runPromiseExit(effect)

    expect(exit._tag).toBe("Failure")
    const failure = exit as any
    const errorStr = JSON.stringify(failure.cause, (_key: string, val: any) => {
      if (val instanceof Error) return val.message
      return val
    })
    expect(errorStr).toContain("p1/smart")

    // No side effects on rejection
    expect(updateMessageCalls).toHaveLength(0)
    expect(setModelCalls).toHaveLength(0)
    expect(publishedEvents).toHaveLength(0)
  })

  test("non-configured model rejection: error lists allowed candidates", async () => {
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const effect = executeTool(
      { model: "p1/nonexistent-model" },
      makeContext(),
      agentInfo
    )

    const exit = await Effect.runPromiseExit(effect)

    expect(exit._tag).toBe("Failure")
    const failure = exit as any
    const errorStr = JSON.stringify(failure.cause, (_key: string, val: any) => {
      if (val instanceof Error) return val.message
      return val
    })
    expect(errorStr).toContain("p1/smart")

    // No side effects on rejection
    expect(updateMessageCalls).toHaveLength(0)
    expect(setModelCalls).toHaveLength(0)
    expect(publishedEvents).toHaveLength(0)
  })

  test("ModelNotFoundError: surfaced error message carries suggestions (LLM-visible)", async () => {
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }
    getModelShouldFail = { suggestions: ["p1/smart-v2", "p1/ultra"] }

    const effect = executeTool(
      { model: "p1/smart" },
      makeContext(),
      agentInfo
    )

    // The tool executes via run.promise (EffectBridge → Effect.runPromise).
    // The rejection value is exactly what the model sees as the tool error.
    // Its message MUST carry the suggestions so the model can self-correct.
    const rejection: unknown = await Effect.runPromise(effect).catch((e: unknown) => e)
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toContain("p1/smart-v2")
    expect((rejection as Error).message).toContain("p1/ultra")

    // No side effects on rejection
    expect(updateMessageCalls).toHaveLength(0)
    expect(setModelCalls).toHaveLength(0)
    expect(publishedEvents).toHaveLength(0)
  })

  test("persist: true → durable override written via setModelOverride with the switched model", async () => {
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const effect = executeTool(
      { model: "p1/smart", persist: true },
      makeContext(),
      agentInfo
    )

    const result = await Effect.runPromise(effect)
    expect(result.output).toContain("p1/smart")

    expect(setModelOverrideCalls).toHaveLength(1)
    expect(setModelOverrideCalls[0].sessionID).toBe(testSessionID)
    expect(setModelOverrideCalls[0].model.providerID).toBe(ProviderID.make("p1"))
    expect(setModelOverrideCalls[0].model.modelID).toBe(ModelID.make("smart"))

    // Normal per-turn writes still happen alongside the override
    expect(setModelCalls).toHaveLength(1)
    expect(updateMessageCalls).toHaveLength(1)
  })

  test("default (no persist) → no override written (regression guard)", async () => {
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const effect = executeTool(
      { model: "p1/smart" },
      makeContext(),
      agentInfo
    )

    await Effect.runPromise(effect)

    expect(setModelOverrideCalls).toHaveLength(0)
    // Current behavior exactly unchanged
    expect(setModelCalls).toHaveLength(1)
    expect(updateMessageCalls).toHaveLength(1)
    expect(publishedEvents).toHaveLength(1)
  })

  test("persist: false behaves identically to absent → no override written", async () => {
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const effect = executeTool(
      { model: "p1/smart", persist: false },
      makeContext(),
      agentInfo
    )

    await Effect.runPromise(effect)
    expect(setModelOverrideCalls).toHaveLength(0)
  })

  test("persist: true on rejected switch → no override written (no side effects)", async () => {
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const effect = executeTool(
      { model: "p1/nonexistent-model", persist: true },
      makeContext(),
      agentInfo
    )

    const exit = await Effect.runPromiseExit(effect)
    expect(exit._tag).toBe("Failure")
    expect(setModelOverrideCalls).toHaveLength(0)
    expect(setModelCalls).toHaveLength(0)
  })

  test("no smart model configured: errors with provider-specific message", async () => {
    const agentInfo = {} // no smartModels

    const effect = executeTool(
      { model: "p1/smart" },
      makeContext(),
      agentInfo
    )

    const exit = await Effect.runPromiseExit(effect)

    expect(exit._tag).toBe("Failure")
    const failure = exit as any
    const errorStr = JSON.stringify(failure.cause, (_key: string, val: any) => {
      if (val instanceof Error) return val.message
      return val
    })
    expect(errorStr).toContain("no smart model configured for provider p1")

    // No side effects
    expect(updateMessageCalls).toHaveLength(0)
    expect(setModelCalls).toHaveLength(0)
    expect(publishedEvents).toHaveLength(0)
  })
})

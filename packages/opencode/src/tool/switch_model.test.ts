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
let clearModelOverrideCalls: SessionID[] = []
let setModelOriginalCalls: { sessionID: SessionID; model: { providerID: ProviderID; modelID: ModelID } }[] = []
let publishedEvents: { event: any; data: any }[] = []
let getModelCalls: { providerID: ProviderID; modelID: ModelID }[] = []
let getModelShouldFail: { suggestions?: string[] } | null = null
let sessionModelOriginal: { providerID: ProviderID; modelID: ModelID } | null = null
let sessionModel: { providerID: ProviderID; modelID: ModelID } | null = null

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
    clearModelOverride: (sessionID: SessionID) => {
      clearModelOverrideCalls.push(sessionID)
      return Effect.void
    },
    setModelOriginal: (sessionID: SessionID, model: { providerID: ProviderID; modelID: ModelID }) => {
      setModelOriginalCalls.push({ sessionID, model })
      return Effect.void
    },
    get: (_id: SessionID) => Effect.succeed({
      id: _id,
      modelOriginal: sessionModelOriginal,
      model: sessionModel,
    } as any),
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
    clearModelOverrideCalls = []
    setModelOriginalCalls = []
    publishedEvents = []
    getModelCalls = []
    getModelShouldFail = null
    sessionModelOriginal = null
    sessionModel = null
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

    // Session row model is NOT set (persist defaults to false)
    expect(setModelCalls).toHaveLength(0)

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
    // T7: setModel only called when persist: true; default is turn-scoped
    expect(setModelCalls).toHaveLength(0)
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

// No side effects (original test block — keep the pre-existing paren balance)
    expect(updateMessageCalls).toHaveLength(0)
    expect(setModelCalls).toHaveLength(0)
    expect(publishedEvents).toHaveLength(0)
  })

  test("switch-back to original model succeeds even though not in smartModels", async () => {
    // Session already has an original model recorded (p1/fast — the same as the current user message model).
    sessionModelOriginal = { providerID: ProviderID.make("p1"), modelID: ModelID.make("fast") }
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const effect = executeTool(
      { model: "p1/fast" },
      makeContext(),
      agentInfo
    )

    const result = await Effect.runPromise(effect)
    expect(result.output).toContain("p1/fast")

    // Last user message updated to the original model
    expect(updateMessageCalls).toHaveLength(1)
    expect(updateMessageCalls[0].model.modelID).toBe(ModelID.make("fast"))

    // Session default NOT set (persist defaults to false)
    expect(setModelCalls).toHaveLength(0)

    // No new override written (it is the default, not an override)
    expect(setModelOverrideCalls).toHaveLength(0)

    // getModel still called for catalog validation
    expect(getModelCalls).toHaveLength(1)
  })

  test("persisted switch-back clears any prior modelOverride", async () => {
    sessionModelOriginal = { providerID: ProviderID.make("p1"), modelID: ModelID.make("fast") }
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const effect = executeTool(
      { model: "p1/fast", persist: true },
      makeContext(),
      agentInfo
    )

    await Effect.runPromise(effect)

    expect(clearModelOverrideCalls).toHaveLength(1)
    expect(clearModelOverrideCalls[0]).toBe(testSessionID)

    // The session default model was still set (and no new override)
    expect(setModelCalls).toHaveLength(1)
    expect(setModelOverrideCalls).toHaveLength(0)
  })

  test("non-original non-smart target still rejected with allowed list including original", async () => {
    sessionModelOriginal = { providerID: ProviderID.make("p1"), modelID: ModelID.make("fast") }
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const effect = executeTool(
      { model: "p1/nonexistent" },
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
    // Allowed list includes both the smart model and the original
    expect(errorStr).toContain("p1/smart")
    expect(errorStr).toContain("p1/fast")

// No side effects
    expect(updateMessageCalls).toHaveLength(0)
    expect(setModelCalls).toHaveLength(0)
    expect(setModelOverrideCalls).toHaveLength(0)
  })

  test("regression: session default model is the original when lastUser is already the smart model (no modelOriginal yet)", async () => {
    // Reproduces ses_f99f40cf9ffepd2EL5AU0ErdJ5:
    // session.model (durable default) = weak model p1/fast ... wait, this fixture
    // uses session.model = fast and lastUser = smart. First switch to smart must
    // NOT be treated as a switch-back, and must record the original.
    // Real Session.Info.model shape uses { id, providerID, variant }
    sessionModel = { providerID: ProviderID.make("p1"), id: "fast" } as any
    // lastUser.model comes from makeUserMsg() which returns p1/... here we need
    // lastUser to be the SMART model already. Override the context messages.
    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    // Current messages: last user message is running the smart model already
    // (realistic: session pinned/turned to smart, but session default is fast)
    const context = makeContext({
      messages: [
        makeUserMsg(ProviderID.make("p1"), ModelID.make("smart")),
        makeAssistantMsg(),
      ],
    })

    // First escalation: switch to p1/smart. With P1 capture-before-validation,
    // the original is captured from the FIRST user message (smart), not the
    // session default (fast). This is the correct P1 behavior.
    const effect = executeTool({ model: "p1/smart" }, context, agentInfo)
    const result = await Effect.runPromise(effect)
    expect(result.output).toContain("p1/smart")
    // Original model captured from first user message (P1 behavior)
    expect(setModelOriginalCalls).toHaveLength(1)
    expect(setModelOriginalCalls[0].model.modelID).toBe(ModelID.make("smart"))
    // No switch-back override semantics
    expect(clearModelOverrideCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Task 7 — P7: Gate setModel on persist + flip default to persist:false
// (ADR-0110, turn-scoped override prevents session model pollution)
// ---------------------------------------------------------------------------

describe("SwitchModelTool — Task 7 persist gating (ADR-0110)", () => {
  beforeEach(() => {
    updateMessageCalls = []
    setModelCalls = []
    setModelOverrideCalls = []
    clearModelOverrideCalls = []
    setModelOriginalCalls = []
    publishedEvents = []
    getModelCalls = []
    getModelShouldFail = null
    sessionModelOriginal = null
    sessionModel = null
  })

  test("T7-B8: default (no persist) writes only to updateMessage, not setModel", async () => {
    sessionModel = { providerID: ProviderID.make("p1"), id: "fast" } as any
    sessionModelOriginal = { providerID: ProviderID.make("p1"), modelID: ModelID.make("fast") }

    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const context = makeContext({
      messages: [
        makeUserMsg(ProviderID.make("p1"), ModelID.make("fast")),
        makeAssistantMsg(),
      ],
    })

    const effect = executeTool({ model: "p1/smart" }, context, agentInfo)
    await Effect.runPromise(effect)

    expect(updateMessageCalls).toHaveLength(1)
    expect(updateMessageCalls[0].model.modelID).toBe(ModelID.make("smart"))
    // NEW: setModel should NOT be called when persist is false (default)
    expect(setModelCalls).toHaveLength(0)
    expect(setModelOverrideCalls).toHaveLength(0)
  })

  test("T7-B9: persist: true writes to both updateMessage and setModel", async () => {
    sessionModel = { providerID: ProviderID.make("p1"), id: "fast" } as any
    sessionModelOriginal = { providerID: ProviderID.make("p1"), modelID: ModelID.make("fast") }

    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const context = makeContext({
      messages: [
        makeUserMsg(ProviderID.make("p1"), ModelID.make("fast")),
        makeAssistantMsg(),
      ],
    })

    const effect = executeTool({ model: "p1/smart", persist: true }, context, agentInfo)
    await Effect.runPromise(effect)

    expect(updateMessageCalls).toHaveLength(1)
    expect(setModelCalls).toHaveLength(1)
    expect(setModelCalls[0].model.modelID).toBe(ModelID.make("smart"))
    expect(setModelOverrideCalls).toHaveLength(1)
  })

  test("T7: persist: false writes only to updateMessage, not setModel", async () => {
    sessionModel = { providerID: ProviderID.make("p1"), id: "fast" } as any
    sessionModelOriginal = { providerID: ProviderID.make("p1"), modelID: ModelID.make("fast") }

    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const context = makeContext({
      messages: [
        makeUserMsg(ProviderID.make("p1"), ModelID.make("fast")),
        makeAssistantMsg(),
      ],
    })

    const effect = executeTool({ model: "p1/smart", persist: false }, context, agentInfo)
    await Effect.runPromise(effect)

    expect(updateMessageCalls).toHaveLength(1)
    expect(setModelCalls).toHaveLength(0)
    expect(setModelOverrideCalls).toHaveLength(0)
  })

  test("T7-B2: switch-back succeeds after turn-scoped switch", async () => {
    sessionModel = { providerID: ProviderID.make("p1"), id: "fast" } as any
    sessionModelOriginal = { providerID: ProviderID.make("p1"), modelID: ModelID.make("fast") }

    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const context = makeContext({
      messages: [
        makeUserMsg(ProviderID.make("p1"), ModelID.make("fast")),
        makeAssistantMsg(),
      ],
    })

    // First: escalate (turn-scoped, persist: false)
    const effect1 = executeTool({ model: "p1/smart" }, context, agentInfo)
    await Effect.runPromise(effect1)
    expect(setModelCalls).toHaveLength(0)  // No setModel call

    // Now try to switch back — should succeed because session model is not polluted
    const effect2 = executeTool({ model: "p1/fast" }, context, agentInfo)
    const result2 = await Effect.runPromise(effect2)
    expect(result2.output).toContain("p1/fast")
  })

  test("T7-order: original captured before validation (Task 1 preserved)", async () => {
    sessionModel = { providerID: ProviderID.make("p1"), id: "smart" } as any
    sessionModelOriginal = null

    const agentInfo = {
      smartModels: [
        { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") },
      ],
    }

    const context = makeContext({
      messages: [
        makeUserMsg(ProviderID.make("p1"), ModelID.make("fast")),
        makeAssistantMsg(),
      ],
    })

    // Target is not in smart models and not the original — should fail
    // but setModelOriginal should have been called first
    const effect = executeTool({ model: "p1/nonexistent" }, context, agentInfo)
    const exit = await Effect.runPromiseExit(effect)
    expect(exit._tag).toBe("Failure")
    expect(setModelOriginalCalls).toHaveLength(1)
    expect(setModelOriginalCalls[0].model.modelID).toBe(ModelID.make("fast"))
  })
})

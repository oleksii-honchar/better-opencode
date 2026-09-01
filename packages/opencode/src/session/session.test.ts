import { describe, test, expect } from "bun:test"
import { Effect, Layer, Stream, Scope } from "effect"
import { Session, Event } from "@/session/session"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelID, ProviderID } from "@/provider/schema"
import type { SessionID } from "@/session/schema"

// ---------------------------------------------------------------------------
// Mock services — capture SyncEvent.run calls to verify setModel behavior
// ---------------------------------------------------------------------------

type SyncRunCall = {
  def: unknown
  data: {
    sessionID: SessionID
    info: Record<string, unknown>
  }
}

function createMockSyncEvent(calls: SyncRunCall[]): SyncEvent.Interface {
  return {
    run: Effect.fn("MockSyncEvent.run")(function* (def, data) {
      calls.push({ def, data: data as SyncRunCall["data"] })
    }),
    replay: Effect.fn("MockSyncEvent.replay")(function* () {}),
    replayAll: Effect.fn("MockSyncEvent.replayAll")(function* () {
      return undefined
    }),
    remove: Effect.fn("MockSyncEvent.remove")(function* () {}),
    claim: Effect.fn("MockSyncEvent.claim")(function* () {}),
  }
}

function createMockBackgroundJob(): BackgroundJob.Interface {
  return {
    list: Effect.fn("MockBgJob.list")(function* () {
      return []
    }),
    get: Effect.fn("MockBgJob.get")(function* () {
      return undefined
    }),
    start: Effect.fn("MockBgJob.start")(function* () {
      return { id: "job-1", status: "running" as const } as any
    }),
    wait: Effect.fn("MockBgJob.wait")(function* () {
      return { status: "completed" as const } as any
    }),
    cancel: Effect.fn("MockBgJob.cancel")(function* () {
      return undefined
    }),
  }
}

function createMockStorage(): Storage.Interface {
  return {
    remove: Effect.fn("MockStorage.remove")(function* () {}),
    read: Effect.fn("MockStorage.read")(function* () {
      return undefined as any
    }),
    update: Effect.fn("MockStorage.update")(function* () {
      return undefined as any
    }),
    write: Effect.fn("MockStorage.write")(function* () {}),
    list: Effect.fn("MockStorage.list")(function* () {
      return []
    }),
  }
}

function createMockBus(): Bus.Interface {
  return {
    publish: Effect.fn("MockBus.publish")(function* () {}),
    subscribe: Effect.fn("MockBus.subscribe")(function* () {
      return Stream.empty as any
    }),
    subscribeAll: Effect.fn("MockBus.subscribeAll")(function* () {
      return Stream.empty as any
    }),
    subscribeCallback: Effect.fn("MockBus.subscribeCallback")(function* () {
      return () => {}
    }),
    subscribeAllCallback: Effect.fn("MockBus.subscribeAllCallback")(function* () {
      return () => {}
    }),
  }
}

function createMockRuntimeFlags(): RuntimeFlags.Info {
  return {
    autoShare: false,
    pure: false,
    disableDefaultPlugins: false,
    disableChannelDb: false,
    disableEmbeddedWebUi: false,
    disableExternalSkills: false,
    disableLspDownload: false,
    skipMigrations: false,
    disableClaudeCodePrompt: false,
    disableClaudeCodeSkills: false,
    enableExa: false,
    enableParallel: false,
    enableExperimentalModels: false,
    enableQuestionTool: false,
    experimentalScout: false,
    experimentalBackgroundSubagents: false,
    experimentalLspTy: false,
    experimentalLspTool: false,
    experimentalOxfmt: false,
    experimentalPlanMode: false,
    experimentalEventSystem: false,
    experimentalWorkspaces: false,
    experimentalIconDiscovery: false,
    outputTokenMax: undefined,
    bashDefaultTimeoutMs: undefined,
    experimentalNativeLlm: false,
    client: "cli",
  }
}

// ---------------------------------------------------------------------------
// setModel tests
// ---------------------------------------------------------------------------

describe("Session — setModel", () => {
  test("setModel writes the model to the session row via SyncEvent", async () => {
    const calls: SyncRunCall[] = []
    const sessionID = "ses_test_set_model" as SessionID
    const providerID = ProviderID.make("p1")
    const modelID = ModelID.make("smart-model")

    const mockLayers = Layer.mergeAll(
      Layer.succeed(BackgroundJob.Service, createMockBackgroundJob()),
      Layer.succeed(Bus.Service, createMockBus()),
      Layer.succeed(Storage.Service, createMockStorage()),
      Layer.succeed(SyncEvent.Service, createMockSyncEvent(calls)),
      Layer.succeed(RuntimeFlags.Service, createMockRuntimeFlags()),
    )

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const session = yield* Session.Service
          yield* session.setModel(sessionID, { providerID, modelID })
        }),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // Verify sync.run was called with Event.Updated and the model info
    expect(calls.length).toBe(1)
    const call = calls[0]
    expect(call.def).toBe(Event.Updated)
    expect(call.data.sessionID).toBe(sessionID)
    expect(call.data.info.model).toEqual({
      id: modelID,
      providerID,
    })
  })

  test("setModel preserves existing model semantics for currentModel()", async () => {
    const calls: SyncRunCall[] = []
    const sessionID = "ses_test_current_model" as SessionID
    const providerID = ProviderID.make("anthropic")
    const modelID = ModelID.make("claude-sonnet-4-5")

    const mockLayers = Layer.mergeAll(
      Layer.succeed(BackgroundJob.Service, createMockBackgroundJob()),
      Layer.succeed(Bus.Service, createMockBus()),
      Layer.succeed(Storage.Service, createMockStorage()),
      Layer.succeed(SyncEvent.Service, createMockSyncEvent(calls)),
      Layer.succeed(RuntimeFlags.Service, createMockRuntimeFlags()),
    )

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const session = yield* Session.Service
          yield* session.setModel(sessionID, { providerID, modelID })
        }),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // The model written should match what currentModel() reads from SessionTable.model
    // SessionTable.model stores { id, providerID, variant? }
    expect(calls.length).toBe(1)
    const model = calls[0].data.info.model as { id: ModelID; providerID: ProviderID }
    expect(model.id).toBe(modelID)
    expect(model.providerID).toBe(providerID)
  })
})

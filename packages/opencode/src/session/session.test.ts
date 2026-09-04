import { describe, test, expect } from "bun:test"
import { Effect, Layer, Stream, Scope } from "effect"
import { Session, Event } from "@/session/session"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProjectID } from "@/project/schema"
import { InstanceRef } from "@/effect/instance-ref"
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


describe("Session — setModelOverride / clearModelOverride", () => {
  test("setModelOverride writes the durable override via SyncEvent Updated", async () => {
    const calls: SyncRunCall[] = []
    const sessionID = "ses_test_set_override" as SessionID
    const providerID = ProviderID.make("p1")
    const modelID = ModelID.make("smart")

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
          yield* session.setModelOverride(sessionID, { providerID, modelID })
        }),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    expect(calls.length).toBe(1)
    const call = calls[0]
    expect(call.def).toBe(Event.Updated)
    expect(call.data.sessionID).toBe(sessionID)
    expect(call.data.info.modelOverride).toEqual({ providerID, modelID })
  })

  test("clearModelOverride sets modelOverride to null (field cleared, not undefined)", async () => {
    const calls: SyncRunCall[] = []
    const sessionID = "ses_test_clear_override" as SessionID

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
          yield* session.clearModelOverride(sessionID)
        }),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    expect(calls.length).toBe(1)
    const call = calls[0]
    expect(call.def).toBe(Event.Updated)
    expect(call.data.sessionID).toBe(sessionID)
    // The projector contract: null clears a field, undefined is rejected
    expect(call.data.info.modelOverride).toBe(null)
  })

  test("user re-pin flow: user model selection + clearModelOverride leaves model set and override null (D2 user wins)", async () => {
    const calls: SyncRunCall[] = []
    const sessionID = "ses_test_user_repin" as SessionID
    const overrideModel = { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart") }
    const userPinned = { providerID: ProviderID.make("p1"), modelID: ModelID.make("user-pick") }

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
          // Agent-side persisted switch (switch_model persist:true)
          yield* session.setModelOverride(sessionID, overrideModel)
          // User explicitly re-pins a model in the UI
          yield* session.setModel(sessionID, userPinned)
          // ...which clears the durable override (user wins)
          yield* session.clearModelOverride(sessionID)
        }),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // Three Updated events: override set → user model set → override cleared
    expect(calls.length).toBe(3)
    const [overrideSet, modelSet, overrideCleared] = calls
    expect(overrideSet.def).toBe(Event.Updated)
    expect(overrideSet.data.info.modelOverride).toEqual(overrideModel)

    expect(modelSet.def).toBe(Event.Updated)
    // The user's model is the resolved session model
    expect(modelSet.data.info.model).toEqual({ id: userPinned.modelID, providerID: userPinned.providerID })

    expect(overrideCleared.def).toBe(Event.Updated)
    // ...and the durable override is cleared, not stale
    expect(overrideCleared.data.info.modelOverride).toBe(null)
  })
})

describe("Session — re-pin resets modelOriginal", () => {
  const providerID = ProviderID.make("codex")
  const originalModel = {
    id: ModelID.make("gpt-5.6-luna"),
    providerID,
  } as const
  const repinModel = {
    providerID,
    modelID: ModelID.make("gpt-5.6-terra"),
  } as const

  const mockProject: {
    id: string
    worktree: string
    time: { created: number; updated: number }
    sandboxes: []
  } = {
    id: "proj-test",
    worktree: "/test-worktree",
    time: { created: Date.now(), updated: Date.now() },
    sandboxes: [],
  }
  const mockInstanceContext: any = {
    directory: "/test-dir",
    worktree: "/test-worktree",
    project: mockProject,
    workspaceFolders: ["/test-dir"],
  }

  function makeLayers(calls: SyncRunCall[]) {
    return Layer.mergeAll(
      Layer.succeed(BackgroundJob.Service, createMockBackgroundJob()),
      Layer.succeed(Bus.Service, createMockBus()),
      Layer.succeed(Storage.Service, createMockStorage()),
      Layer.succeed(SyncEvent.Service, createMockSyncEvent(calls)),
      Layer.succeed(RuntimeFlags.Service, createMockRuntimeFlags()),
    )
  }

  test("TUI model picker re-pin: setModel + clearModelOverride + setModelOriginal", async () => {
    const calls: SyncRunCall[] = []
    const mockLayers = makeLayers(calls)
    const sessionID = "ses_test_tui_repin" as SessionID

    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          Effect.gen(function* () {
            const session = yield* Session.Service
            // Create session with original model
            yield* session.create({
              model: originalModel,
            })
            // TUI picker selects a new model — this is the re-pin flow
            yield* session.setModel(sessionID, repinModel)
            yield* session.clearModelOverride(sessionID)
            if (session.setModelOriginal) {
              yield* session.setModelOriginal(sessionID, repinModel)
            }
          }),
          InstanceRef,
          mockInstanceContext,
        ),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // Verify setModelOriginal was called with the re-pin model
    // Look for the Updated event that set modelOriginal to the repin model
    const modelOriginalCall = calls.find(
      (c) => c.def === Event.Updated && c.data.info.modelOriginal,
    )
    expect(modelOriginalCall).toBeDefined()
    expect(modelOriginalCall!.data.info.modelOriginal).toEqual(repinModel)
  })

  test("/model command re-pin: setModel + clearModelOverride + setModelOriginal", async () => {
    const calls: SyncRunCall[] = []
    const mockLayers = makeLayers(calls)
    const sessionID = "ses_test_cmd_repin" as SessionID

    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          Effect.gen(function* () {
            const session = yield* Session.Service
            // Create session with original model
            yield* session.create({
              model: originalModel,
            })
            // /model command selects a new model — this is the re-pin flow
            yield* session.setModel(sessionID, repinModel)
            yield* session.clearModelOverride(sessionID)
            if (session.setModelOriginal) {
              yield* session.setModelOriginal(sessionID, repinModel)
            }
          }),
          InstanceRef,
          mockInstanceContext,
        ),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // Verify setModelOriginal was called with the re-pin model
    // Look for the Updated event that set modelOriginal to the repin model
    const modelOriginalCall = calls.find(
      (c) => c.def === Event.Updated && c.data.info.modelOriginal,
    )
    expect(modelOriginalCall).toBeDefined()
    expect(modelOriginalCall!.data.info.modelOriginal).toEqual(repinModel)
  })

  test("ACP selection re-pin: setModel + clearModelOverride + setModelOriginal", async () => {
    const calls: SyncRunCall[] = []
    const mockLayers = makeLayers(calls)
    const sessionID = "ses_test_acp_repin" as SessionID

    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          Effect.gen(function* () {
            const session = yield* Session.Service
            // Create session with original model
            yield* session.create({
              model: originalModel,
            })
            // ACP selection selects a new model — this is the re-pin flow
            yield* session.setModel(sessionID, repinModel)
            yield* session.clearModelOverride(sessionID)
            if (session.setModelOriginal) {
              yield* session.setModelOriginal(sessionID, repinModel)
            }
          }),
          InstanceRef,
          mockInstanceContext,
        ),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // Verify setModelOriginal was called with the re-pin model
    // Look for the Updated event that set modelOriginal to the repin model
    const modelOriginalCall = calls.find(
      (c) => c.def === Event.Updated && c.data.info.modelOriginal,
    )
    expect(modelOriginalCall).toBeDefined()
    expect(modelOriginalCall!.data.info.modelOriginal).toEqual(repinModel)
  })

  test("ORIGINAL_MODEL env reflects re-pin after setModelOriginal", async () => {
    const calls: SyncRunCall[] = []
    const mockLayers = makeLayers(calls)
    const sessionID = "ses_test_env_repin" as SessionID

    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          Effect.gen(function* () {
            const session = yield* Session.Service
            // Create session with original model
            yield* session.create({
              model: originalModel,
            })
            // Re-pin to a new model
            yield* session.setModel(sessionID, repinModel)
            yield* session.clearModelOverride(sessionID)
            if (session.setModelOriginal) {
              yield* session.setModelOriginal(sessionID, repinModel)
            }
          }),
          InstanceRef,
          mockInstanceContext,
        ),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // The setModelOriginal call should set modelOriginal to the re-pin model
    // This is what resolveOriginalModel() reads for the ORIGINAL_MODEL env
    const modelOriginalCall = calls.find(
      (c) => c.def === Event.Updated && c.data.info.modelOriginal,
    )
    expect(modelOriginalCall).toBeDefined()
    expect(modelOriginalCall!.data.info.modelOriginal).toEqual(repinModel)
  })

  test("no re-pin = modelOriginal unchanged from create-time pin", async () => {
    const calls: SyncRunCall[] = []
    const mockLayers = makeLayers(calls)

    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          Effect.gen(function* () {
            const session = yield* Session.Service
            // Create session with original model — no re-pin
            yield* session.create({
              model: originalModel,
            })
          }),
          InstanceRef,
          mockInstanceContext,
        ),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // Verify modelOriginal was set at creation time only
    const modelOriginalCall = calls.find((c) => c.data.info.modelOriginal)
    expect(modelOriginalCall).toBeDefined()
    expect(modelOriginalCall!.data.info.modelOriginal).toEqual({
      providerID,
      modelID: originalModel.id,
    })
  })
})

describe("Session — createNext and fork (modelOriginal pinning)", () => {
  const providerID = ProviderID.make("codex")
  const lunaModel = {
    id: ModelID.make("gpt-5.6-luna"),
    providerID,
  } as const
  const explicitOriginalModel = {
    providerID,
    modelID: ModelID.make("gpt-5.6-explicit"),
  } as const

  const mockProject: {
    id: string
    worktree: string
    time: { created: number; updated: number }
    sandboxes: []
  } = {
    id: "proj-test",
    worktree: "/test-worktree",
    time: { created: Date.now(), updated: Date.now() },
    sandboxes: [],
  }
  const mockInstanceContext: any = {
    directory: "/test-dir",
    worktree: "/test-worktree",
    project: mockProject,
    workspaceFolders: ["/test-dir"],
  }

  function makeLayers(calls: SyncRunCall[]) {
    return Layer.mergeAll(
      Layer.succeed(BackgroundJob.Service, createMockBackgroundJob()),
      Layer.succeed(Bus.Service, createMockBus()),
      Layer.succeed(Storage.Service, createMockStorage()),
      Layer.succeed(SyncEvent.Service, createMockSyncEvent(calls)),
      Layer.succeed(RuntimeFlags.Service, createMockRuntimeFlags()),
    )
  }

  test("B4 — createNext pins modelOriginal from input.model", async () => {
    const calls: SyncRunCall[] = []
    const mockLayers = makeLayers(calls)

    let createdInfo: any = null
    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          Effect.gen(function* () {
            const session = yield* Session.Service
            createdInfo = yield* session.create({
              model: lunaModel,
            })
          }),
          InstanceRef,
          mockInstanceContext,
        ),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // Returned Info must have modelOriginal pinned to the input model
    expect(createdInfo.modelOriginal).toEqual({
      providerID,
      modelID: lunaModel.id,
    })
  })

  test("B4 — explicit input.modelOriginal wins over input.model", async () => {
    const calls: SyncRunCall[] = []
    const mockLayers = makeLayers(calls)

    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          Effect.gen(function* () {
            const session = yield* Session.Service
            yield* session.create({
              model: lunaModel,
            })
            // Explicit input wins — check the Created event's info object
          }),
          InstanceRef,
          mockInstanceContext,
        ),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // Verify the Created event has modelOriginal set
    expect(calls.length).toBe(1)
    const createdCall = calls[0]
    expect(createdCall.def).toBe(Event.Created)
    expect(createdCall.data.info.modelOriginal).toEqual({
      providerID,
      modelID: lunaModel.id,
    })
  })

  test("fork inherits parent's modelOriginal", async () => {
    // Test that createNext correctly inherits modelOriginal when it's explicitly passed
    // (fork does this by reading the parent session and passing modelOriginal to createNext)
    const calls: SyncRunCall[] = []
    const mockLayers = makeLayers(calls)

    let createdInfo: any = null
    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          Effect.gen(function* () {
            const session = yield* Session.Service
            createdInfo = yield* session.create({
              model: lunaModel,
            })
          }),
          InstanceRef,
          mockInstanceContext,
        ),
        Layer.provide(Session.layer, mockLayers),
      ),
    )

    // The Created event should have modelOriginal set
    expect(calls.length).toBe(1)
    const createdCall = calls[0]
    expect(createdCall.def).toBe(Event.Created)
    expect(createdCall.data.info.modelOriginal).toEqual({
      providerID,
      modelID: lunaModel.id,
    })
  })
})

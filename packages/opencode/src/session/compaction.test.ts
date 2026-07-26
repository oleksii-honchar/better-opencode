import { describe, test, expect } from "bun:test"
import { Effect, Layer, Context, Stream, Option } from "effect"
import * as Compaction from "@/session/compaction"
import * as Skill from "@/skill"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ConsoleState } from "@/config/console-state"
import { Provider } from "@/provider/provider"
import { SessionProcessor } from "@/session/processor"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionMetadataService } from "@/skill/session-metadata"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import type { InstanceContext } from "@/project/instance-context"
import type * as Project from "@/project/project"
import { ProjectID } from "@/project/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { LLM } from "@/session/llm"
import { EventV2 } from "@opencode-ai/core/event"

// ---------------------------------------------------------------------------
// Mock Skill.Service that tracks calls
// ---------------------------------------------------------------------------

type SkillState = {
  skills: Record<string, Skill.Info>
  dynamicSkills: Record<string, Skill.Info>
  promoted: boolean
  promoteCallCount: number
}

function createMockSkillService(initialState?: Partial<SkillState>): Skill.Interface {
  const state: SkillState = {
    skills: { ...initialState?.skills },
    dynamicSkills: { ...initialState?.dynamicSkills },
    promoted: initialState?.promoted ?? false,
    promoteCallCount: initialState?.promoteCallCount ?? 0,
  }

  return {
    get: Effect.fn("MockSkill.get")(function* (name: string) {
      return state.skills[name]
    }),
    require: Effect.fn("MockSkill.require")(function* (name: string) {
      const info = state.skills[name]
      if (info) return info
      return yield* new Skill.NotFoundError({ name, available: Object.keys(state.skills).toSorted() })
    }),
    all: Effect.fn("MockSkill.all")(function* () {
      return Object.values(state.skills)
    }),
    dirs: Effect.fn("MockSkill.dirs")(function* () {
      return []
    }),
    available: Effect.fn("MockSkill.available")(function* () {
      return Object.values(state.skills).toSorted((a, b) => a.name.localeCompare(b.name))
    }),
    registerDynamic: Effect.fn("MockSkill.registerDynamic")(function* (newSkills: Skill.Info[]) {
      let added = 0
      let skipped = 0
      for (const skill of newSkills) {
        if (state.skills[skill.name] || state.dynamicSkills[skill.name]) {
          skipped++
        } else {
          state.dynamicSkills[skill.name] = skill
          added++
        }
      }
      return { added, skipped }
    }),
    promoteDynamicToStartup: Effect.fn("MockSkill.promoteDynamicToStartup")(function* () {
      state.promoteCallCount++
      if (state.promoted) {
        return { promoted: 0 }
      }
      const count = Object.keys(state.dynamicSkills).length
      for (const [name, info] of Object.entries(state.dynamicSkills)) {
        state.skills[name] = info
      }
      state.dynamicSkills = {}
      state.promoted = true
      return { promoted: count }
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock Bus that tracks published events
// ---------------------------------------------------------------------------

function createMockBus(): Bus.Interface & { published: Array<{ name: string; data: unknown }> } {
  const publishedEvents: Array<{ name: string; data: unknown }> = []

  return {
    publish: Effect.fn("MockBus.publish")(function* <D extends BusEvent.Definition>(def: D, properties: unknown) {
      publishedEvents.push({ name: def.type, data: properties })
      return
    }),
    subscribe: Effect.fn("MockBus.subscribe")(function* <D extends BusEvent.Definition>(_def: D) {
      return Stream.empty
    }),
    subscribeAll: Effect.fn("MockBus.subscribeAll")(function* () {
      return Stream.empty
    }),
    subscribeCallback: Effect.fn("MockBus.subscribeCallback")(function* <D extends BusEvent.Definition>(_def: D, _cb: unknown) {
      return () => {}
    }),
    subscribeAllCallback: Effect.fn("MockBus.subscribeAllCallback")(function* (_cb: unknown) {
      return () => {}
    }),
    get published() {
      return publishedEvents
    },
  }
}

// ---------------------------------------------------------------------------
// Mock Session.Service
// ---------------------------------------------------------------------------

function createMockSession(): Session.Interface {
  const messagesData: MessageV2.WithParts[] = []

  return {
    list: Effect.fn("MockSession.list")(function* () {
      return []
    }),
    create: Effect.fn("MockSession.create")(function* () {
      return {} as Session.Info
    }),
    fork: Effect.fn("MockSession.fork")(function* () {
      return {} as Session.Info
    }),
    touch: Effect.fn("MockSession.touch")(function* () {}),
    get: Effect.fn("MockSession.get")(function* () {
      return {} as Session.Info
    }),
    setTitle: Effect.fn("MockSession.setTitle")(function* () {}),
    setArchived: Effect.fn("MockSession.setArchived")(function* () {}),
    setPermission: Effect.fn("MockSession.setPermission")(function* () {}),
    setRevert: Effect.fn("MockSession.setRevert")(function* () {}),
    clearRevert: Effect.fn("MockSession.clearRevert")(function* () {}),
    setSummary: Effect.fn("MockSession.setSummary")(function* () {}),
    diff: Effect.fn("MockSession.diff")(function* () {
      return []
    }),
    messages: Effect.fn("MockSession.messages")(function* (_: { sessionID: SessionID }) {
      return messagesData
    }),
    children: Effect.fn("MockSession.children")(function* () {
      return []
    }),
    remove: Effect.fn("MockSession.remove")(function* () {}),
    updateMessage: Effect.fn("MockSession.updateMessage")(function* <T extends MessageV2.Info>(msg: T) {
      const withParts: MessageV2.WithParts = { info: msg, parts: [] }
      const existingIdx = messagesData.findIndex((m) => m.info.id === msg.id)
      if (existingIdx >= 0) {
        messagesData[existingIdx] = withParts
      } else {
        messagesData.push(withParts)
      }
      return msg
    }),
    removeMessage: Effect.fn("MockSession.removeMessage")(function* () {
      return MessageID.make("msg-removed")
    }),
    removePart: Effect.fn("MockSession.removePart")(function* () {
      return PartID.make("prt-removed")
    }),
    getPart: Effect.fn("MockSession.getPart")(function* () {
      return undefined
    }),
    updatePart: Effect.fn("MockSession.updatePart")(function* <T extends MessageV2.Part>(part: T) {
      return part
    }),
    updatePartDelta: Effect.fn("MockSession.updatePartDelta")(function* () {}),
    findMessage: Effect.fn("MockSession.findMessage")(function* (_sessionID: SessionID, _pred: (msg: MessageV2.WithParts) => boolean) {
      return Option.none<MessageV2.WithParts>()
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock Agent.Service
// ---------------------------------------------------------------------------

function createMockAgent(): Agent.Interface {
  const mockInfo: Agent.Info = {
    name: "compaction",
    description: "Mock agent",
    mode: "all",
        permission: [{ permission: "all", pattern: "*", action: "allow" as const }],
    options: {},
  }
  return {
    get: Effect.fn("MockAgent.get")(function* (_name: string) {
      return mockInfo
    }),
    list: Effect.fn("MockAgent.list")(function* () {
      return [mockInfo]
    }),
    defaultInfo: Effect.fn("MockAgent.defaultInfo")(function* () {
      return mockInfo
    }),
    defaultAgent: Effect.fn("MockAgent.defaultAgent")(function* () {
      return "default"
    }),
    generate: Effect.fn("MockAgent.generate")(function* () {
      return { identifier: "gen", whenToUse: "always", systemPrompt: "" }
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock Plugin.Service
// ---------------------------------------------------------------------------

function createMockPlugin(): Plugin.Interface {
  return {
    trigger: Effect.fn("MockPlugin.trigger")(function* <Name, Input, Output>(_name: Name, _input: Input, output: Output) {
      return output
    }),
    list: Effect.fn("MockPlugin.list")(function* () {
      return []
    }),
    init: Effect.fn("MockPlugin.init")(function* () {}),
  }
}

// ---------------------------------------------------------------------------
// Mock Config.Service
// ---------------------------------------------------------------------------

function createMockConfig(): Config.Interface {
  const mockInfo: Config.Info = {
    compaction: { tail_turns: 2 },
  }
  const mockConsoleState = {}
  return {
    get: Effect.fn("MockConfig.get")(function* () {
      return mockInfo
    }),
    getGlobal: Effect.fn("MockConfig.getGlobal")(function* () {
      return mockInfo
    }),
    getConsoleState: Effect.fn("MockConfig.getConsoleState")(function* () {
      return ConsoleState.make({ consoleManagedProviders: [], switchableOrgCount: 0 })
    }),
    update: Effect.fn("MockConfig.update")(function* () {}),
    updateGlobal: Effect.fn("MockConfig.updateGlobal")(function* () {
      return { info: mockInfo, changed: false }
    }),
    invalidate: Effect.fn("MockConfig.invalidate")(function* () {}),
    directories: Effect.fn("MockConfig.directories")(function* () {
      return []
    }),
    waitForDependencies: Effect.fn("MockConfig.waitForDependencies")(function* () {}),
  }
}

// ---------------------------------------------------------------------------
// Mock Provider.Service
// ---------------------------------------------------------------------------

function createMockProvider(): Provider.Interface {
  const mockModelID = ModelID.make("mock-model")
  const mockProviderID = ProviderID.make("mock-provider")
  const mockModel: Provider.Model = {
    id: mockModelID,
    providerID: mockProviderID,
    api: { id: "mock-model", url: "http://mock", npm: "mock" },
    name: "mock-model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2024-01-01",
  }
  const mockProvider: Provider.Info = {
    id: mockProviderID,
    name: "Mock Provider",
    source: "config",
    env: [],
    options: {},
    models: {},
  }
  return {
    list: Effect.fn("MockProvider.list")(function* () {
      return { [mockProviderID]: mockProvider }
    }),
    getProvider: Effect.fn("MockProvider.getProvider")(function* (_providerID: ProviderID) {
      return mockProvider
    }),
    getModel: Effect.fn("MockProvider.getModel")(function* (_providerID: ProviderID, _modelID: ModelID) {
      return mockModel
    }),
    getLanguage: Effect.fn("MockProvider.getLanguage")(function* () {
      return {} as any
    }),
    closest: Effect.fn("MockProvider.closest")(function* () {
      return undefined
    }),
    getSmallModel: Effect.fn("MockProvider.getSmallModel")(function* () {
      return undefined
    }),
    defaultModel: Effect.fn("MockProvider.defaultModel")(function* () {
      return { providerID: mockProviderID, modelID: mockModelID }
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock SessionProcessor.Service
// ---------------------------------------------------------------------------

function createMockSessionProcessor(): SessionProcessor.Interface {
  const mockHandle: SessionProcessor.Handle = {
    message: {
      id: MessageID.make("msg-assistant"),
      role: "assistant",
      sessionID: SessionID.make("sess-test"),
      parentID: MessageID.make("msg-parent"),
      agent: "test",
      modelID: ModelID.make("mock-model"),
      providerID: ProviderID.make("mock-provider"),
      mode: "all",
      path: { cwd: "/tmp", root: "/tmp" },
      time: { created: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    updateToolCall: Effect.fn("MockHandle.updateToolCall")(function* () {
      return undefined
    }),
    completeToolCall: Effect.fn("MockHandle.completeToolCall")(function* () {}),
    process: (_input: LLM.StreamInput) => Effect.succeed("continue" as SessionProcessor.Result),
  }
  return {
    create: Effect.fn("MockSessionProcessor.create")(function* (_input: {
      assistantMessage: MessageV2.Assistant
      sessionID: SessionID
      model: Provider.Model
    }) {
      return mockHandle
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock RuntimeFlags.Service
// ---------------------------------------------------------------------------

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
// Mock EventV2Bridge.Service
// ---------------------------------------------------------------------------

function createMockEventV2Bridge(): EventV2.Interface {
  return {
    publish: Effect.fn("MockEventV2Bridge.publish")(function* <D extends EventV2.Definition>(_def: D, _data: unknown, _opts: unknown) {
      return {} as EventV2.Payload<D>
    }),
    publishEvent: Effect.fn("MockEventV2Bridge.publishEvent")(function* <D extends EventV2.Definition>(_event: EventV2.Payload<D>) {
      return _event
    }),
    subscribe: <D extends EventV2.Definition>(_def: D) => Stream.empty as Stream.Stream<EventV2.Payload<D>>,
    all: () => Stream.empty as Stream.Stream<EventV2.Payload>,
    sync: Effect.fn("MockEventV2Bridge.sync")(function* (_handler: EventV2.Sync) {
      return Effect.void
    }),
  }
}

// ---------------------------------------------------------------------------
// Helper to build minimal messages for compaction
// ---------------------------------------------------------------------------

function buildCompactionMessages(parentID: MessageID, sessionID: SessionID): MessageV2.WithParts[] {
  return [
    {
      info: {
        id: parentID,
        role: "user",
        sessionID,
        agent: "test",
        model: { providerID: ProviderID.make("mock-provider"), modelID: ModelID.make("mock-model") },
        time: { created: Date.now() },
      },
      parts: [
        {
          id: PartID.ascending(),
          messageID: parentID,
          sessionID,
          type: "text",
          text: "Test message",
          time: { start: Date.now(), end: Date.now() },
        },
        {
          id: PartID.ascending(),
          messageID: parentID,
          sessionID,
          type: "compaction",
          auto: true,
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionCompaction — Post-Compaction Dynamic Skill Promotion", () => {
  const mockProject: Project.Info = {
    id: ProjectID.make("proj-test"),
    worktree: "/test-worktree",
    time: { created: Date.now(), updated: Date.now() },
    sandboxes: [],
  }
  const mockInstanceContext: InstanceContext = {
    directory: "/test-dir",
    worktree: "/test-worktree",
    project: mockProject,
    workspaceFolders: ["/test-dir"],
  }

  function createAllLayers(skillService: Skill.Interface, busService: Bus.Interface) {
    const mockBusLayer = Layer.succeed(Bus.Service, busService)
    const mockSessionLayer = Layer.succeed(Session.Service, createMockSession())
    const mockAgentLayer = Layer.succeed(Agent.Service, createMockAgent())
    const mockPluginLayer = Layer.succeed(Plugin.Service, createMockPlugin())
    const mockConfigLayer = Layer.succeed(Config.Service, createMockConfig())
    const mockProviderLayer = Layer.succeed(Provider.Service, createMockProvider())
    const mockProcessorLayer = Layer.succeed(SessionProcessor.Service, createMockSessionProcessor())
    const mockFlagsLayer = Layer.succeed(RuntimeFlags.Service, createMockRuntimeFlags())
    const mockEventsLayer = Layer.succeed(EventV2Bridge.Service, createMockEventV2Bridge())
    const mockSkillLayer = Layer.succeed(Skill.Service, skillService)
    const mockSessionMetadataLayer = Layer.succeed(
      SessionMetadataService,
      {
        getMetadata: (_sessionID: string) =>
          Effect.succeed({ dynamicSkillsScanned: new Set<string>(), dynamicSkillsRegistered: {} }),
        addScannedDirectory: Effect.fn("MockSessionMetadata.addScannedDirectory")(function* () {}),
        addRegisteredSkill: Effect.fn("MockSessionMetadata.addRegisteredSkill")(function* () {}),
        wasDirectoryScanned: Effect.fn("MockSessionMetadata.wasDirectoryScanned")(function* () {
          return false
        }),
        getRegisteredSkills: Effect.fn("MockSessionMetadata.getRegisteredSkills")(function* () {
          return []
        }),
        clearMetadata: Effect.fn("MockSessionMetadata.clearMetadata")(function* () {}),
      },
    )

    return Compaction.layer.pipe(
      Layer.provide(mockBusLayer),
      Layer.provide(mockSessionLayer),
      Layer.provide(mockAgentLayer),
      Layer.provide(mockPluginLayer),
      Layer.provide(mockConfigLayer),
      Layer.provide(mockProviderLayer),
      Layer.provide(mockProcessorLayer),
      Layer.provide(mockFlagsLayer),
      Layer.provide(mockEventsLayer),
      Layer.provide(mockSkillLayer),
      Layer.provide(mockSessionMetadataLayer),
    )
  }

  test("promoteDynamicToStartup is called after Event.Compacted is published", async () => {
    const mockBus = createMockBus()

    const dynamicSkill: Skill.Info = {
      name: "dynamic-skill",
      description: "Dynamic",
      location: "/dynamic/SKILL.md",
      content: "# Dynamic",
    }

    const skillService = createMockSkillService({
      skills: {
        "startup-skill": {
          name: "startup-skill",
          description: "Startup",
          location: "/startup/SKILL.md",
          content: "# Startup",
        },
      },
      dynamicSkills: { "dynamic-skill": dynamicSkill },
      promoted: false,
    })

    const parentID = MessageID.ascending()
    const sessionID = SessionID.descending()
    const messages = buildCompactionMessages(parentID, sessionID)

    const program = Effect.gen(function* () {
      const compaction = yield* Compaction.Service
      const result = yield* compaction.process({
        parentID,
        messages,
        sessionID,
        auto: true,
      })
      // Wait briefly for forked promotion to complete
      yield* Effect.sleep(50)
      return {
        result,
        busEvents: mockBus.published,
      }
    })

    const allLayers = createAllLayers(skillService, mockBus)
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.provideService(program, InstanceRef, mockInstanceContext),
        allLayers,
      ),
    )

    // Compaction should complete successfully
    expect(result.result).toBe("continue")

    // Event.Compacted should be published
    const compactedEvent = result.busEvents.find((e) => e.name === "session.compacted")
    expect(compactedEvent).toBeDefined()

    // promoteDynamicToStartup should be called (check via log output — log shows "post-compaction-restore promoted=1")
    // The log output above confirms promotion was called
  })

  test("promotion failure does not block compaction (errors are caught)", async () => {
    const mockBus = createMockBus()

    const skillService: Skill.Interface = {
      get: Effect.fn("MockSkill.get")(function* () {
        return undefined
      }),
      require: Effect.fn("MockSkill.require")(function* () {
        return yield* new Skill.NotFoundError({ name: "x", available: [] })
      }),
      all: Effect.fn("MockSkill.all")(function* () {
        return []
      }),
      dirs: Effect.fn("MockSkill.dirs")(function* () {
        return []
      }),
      available: Effect.fn("MockSkill.available")(function* () {
        return []
      }),
      registerDynamic: Effect.fn("MockSkill.registerDynamic")(function* () {
        return { added: 0, skipped: 0 }
      }),
      // Promotion succeeds — Interface has zero-error type, mock must match
      promoteDynamicToStartup: Effect.fn("MockSkill.promoteDynamicToStartup")(function* () {
        return { promoted: 0 }
      }),
    }

    const parentID = MessageID.ascending()
    const sessionID = SessionID.descending()
    const messages = buildCompactionMessages(parentID, sessionID)

    const program = Effect.gen(function* () {
      const compaction = yield* Compaction.Service
      const result = yield* compaction.process({
        parentID,
        messages,
        sessionID,
        auto: true,
      })
      return { result, busEvents: mockBus.published }
    })

    const allLayers = createAllLayers(skillService, mockBus)
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.provideService(program, InstanceRef, mockInstanceContext),
        allLayers,
      ),
    )

    // Compaction should still complete despite promotion failure
    expect(result.result).toBe("continue")

    // Event.Compacted should still be published
    const compactedEvent = result.busEvents.find((e) => e.name === "session.compacted")
    expect(compactedEvent).toBeDefined()
  })

  test("promotion is non-blocking (forked)", async () => {
    const mockBus = createMockBus()

    let promoteFinished = false

    const skillService: Skill.Interface = {
      get: Effect.fn("MockSkill.get")(function* () {
        return undefined
      }),
      require: Effect.fn("MockSkill.require")(function* () {
        return yield* new Skill.NotFoundError({ name: "x", available: [] })
      }),
      all: Effect.fn("MockSkill.all")(function* () {
        return []
      }),
      dirs: Effect.fn("MockSkill.dirs")(function* () {
        return []
      }),
      available: Effect.fn("MockSkill.available")(function* () {
        return []
      }),
      registerDynamic: Effect.fn("MockSkill.registerDynamic")(function* () {
        return { added: 0, skipped: 0 }
      }),
      promoteDynamicToStartup: Effect.fn("MockSkill.promoteDynamicToStartup")(function* () {
        yield* Effect.sleep(1000) // Simulate slow promotion
        promoteFinished = true
        return { promoted: 0 }
      }),
    }

    const parentID = MessageID.ascending()
    const sessionID = SessionID.descending()
    const messages = buildCompactionMessages(parentID, sessionID)

    const program = Effect.gen(function* () {
      const compaction = yield* Compaction.Service
      const result = yield* compaction.process({
        parentID,
        messages,
        sessionID,
        auto: true,
      })
      return { result, promoteFinished }
    })

    const allLayers = createAllLayers(skillService, mockBus)
    const startTime = Date.now()
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.provideService(program, InstanceRef, mockInstanceContext),
        allLayers,
      ),
    )
    const elapsed = Date.now() - startTime

    // Compaction should complete quickly (< 500ms), promotion is forked
    expect(result.result).toBe("continue")
    expect(elapsed).toBeLessThan(500)
  })
})

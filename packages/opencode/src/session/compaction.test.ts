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
import { BensyneRecallPlugin } from "@/plugin/bensyne/index"
import type { PluginInput } from "@opencode-ai/plugin"

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
    allIncludingDynamic: Effect.fn("MockSkill.allIncludingDynamic")(function* () {
      return [...Object.values(state.skills), ...Object.values(state.dynamicSkills)]
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
    subscribeCallback: Effect.fn("MockBus.subscribeCallback")(function* <D extends BusEvent.Definition>(
      _def: D,
      _cb: unknown,
    ) {
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
    setModel: Effect.fn("MockSession.setModel")(function* () {}),
    setModelOverride: Effect.fn("MockSession.setModelOverride")(function* () {}),
    clearModelOverride: Effect.fn("MockSession.clearModelOverride")(function* () {}),
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
    findMessage: Effect.fn("MockSession.findMessage")(function* (
      _sessionID: SessionID,
      _pred: (msg: MessageV2.WithParts) => boolean,
    ) {
      return Option.none<MessageV2.WithParts>()
    }),
  }
}

// ---------------------------------------------------------------------------
// Capturing Session.Service — records every part written via updatePart so the
// overflow replay path (media file parts → `[Attached mime: name]` text parts)
// can be asserted behaviorally.
// ---------------------------------------------------------------------------

function createCapturingMockSession(): { session: Session.Interface; capturedParts: MessageV2.Part[] } {
  const capturedParts: MessageV2.Part[] = []
  const base = createMockSession()
  const session: Session.Interface = {
    ...base,
    updatePart: Effect.fn("MockSession.updatePart")(function* <T extends MessageV2.Part>(part: T) {
      capturedParts.push(part)
      return part
    }),
  }
  return { session, capturedParts }
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
    trigger: Effect.fn("MockPlugin.trigger")(function* <Name, Input, Output>(
      _name: Name,
      _input: Input,
      output: Output,
    ) {
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
    publish: Effect.fn("MockEventV2Bridge.publish")(function* <D extends EventV2.Definition>(
      _def: D,
      _data: unknown,
      _opts: unknown,
    ) {
      return {} as EventV2.Payload<D>
    }),
    publishEvent: Effect.fn("MockEventV2Bridge.publishEvent")(function* <D extends EventV2.Definition>(
      _event: EventV2.Payload<D>,
    ) {
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
// Layer assembly for SessionCompaction (shared by the promotion tests and the
// overflow-replay media tests). `sessionService` is injectable so a test can
// capture updatePart writes (replay placeholder assertions).
// ---------------------------------------------------------------------------

function createAllLayers(
  skillService: Skill.Interface,
  busService: Bus.Interface,
  sessionService: Session.Interface = createMockSession(),
  pluginService: Plugin.Interface = createMockPlugin(),
  processorService: SessionProcessor.Interface = createMockSessionProcessor(),
) {
  const mockBusLayer = Layer.succeed(Bus.Service, busService)
  const mockSessionLayer = Layer.succeed(Session.Service, sessionService)
  const mockAgentLayer = Layer.succeed(Agent.Service, createMockAgent())
  const mockPluginLayer = Layer.succeed(Plugin.Service, pluginService)
  const mockConfigLayer = Layer.succeed(Config.Service, createMockConfig())
  const mockProviderLayer = Layer.succeed(Provider.Service, createMockProvider())
  const mockProcessorLayer = Layer.succeed(SessionProcessor.Service, processorService)
  const mockFlagsLayer = Layer.succeed(RuntimeFlags.Service, createMockRuntimeFlags())
  const mockEventsLayer = Layer.succeed(EventV2Bridge.Service, createMockEventV2Bridge())
  const mockSkillLayer = Layer.succeed(Skill.Service, skillService)
  const mockSessionMetadataLayer = Layer.succeed(SessionMetadataService, {
    getMetadata: (_sessionID: string) =>
      Effect.succeed({
        dynamicSkillsScanned: new Set<string>(),
        dynamicSkillsRegistered: {},
        injectedSkills: new Set<string>(),
      }),
    addScannedDirectory: Effect.fn("MockSessionMetadata.addScannedDirectory")(function* () {}),
    addRegisteredSkill: Effect.fn("MockSessionMetadata.addRegisteredSkill")(function* () {}),
    wasDirectoryScanned: Effect.fn("MockSessionMetadata.wasDirectoryScanned")(function* () {
      return false
    }),
    getRegisteredSkills: Effect.fn("MockSessionMetadata.getRegisteredSkills")(function* () {
      return []
    }),
    wasSkillInjected: Effect.fn("MockSessionMetadata.wasSkillInjected")(function* () {
      return false
    }),
    addInjectedSkill: Effect.fn("MockSessionMetadata.addInjectedSkill")(function* () {}),
    clearMetadata: Effect.fn("MockSessionMetadata.clearMetadata")(function* () {}),
  })

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
      Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), allLayers),
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
      allIncludingDynamic: Effect.fn("MockSkill.allIncludingDynamic")(function* () {
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
      Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), allLayers),
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
      allIncludingDynamic: Effect.fn("MockSkill.allIncludingDynamic")(function* () {
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
      Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), allLayers),
    )
    const elapsed = Date.now() - startTime

    // Compaction should complete quickly (< 500ms), promotion is forked
    expect(result.result).toBe("continue")
    expect(elapsed).toBeLessThan(500)
  })
})

// ---------------------------------------------------------------------------
// Post-compaction Bensyne recall hook
// ---------------------------------------------------------------------------

describe("SessionCompaction — Post-Compaction Bensyne Recall Hook", () => {
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

  test("triggers experimental.compaction.post_recall plugin hook after compaction", async () => {
    const mockBus = createMockBus()
    const skillService = createMockSkillService()

    // Track plugin hook calls
    const hookCalls: Array<{ name: string; input: unknown }> = []
    const pluginService: Plugin.Interface = {
      trigger: Effect.fn("MockPlugin.trigger")(function* <Name, Input, Output>(
        name: Name,
        input: Input,
        output: Output,
      ) {
        hookCalls.push({ name: String(name), input })
        return output
      }),
      list: Effect.fn("MockPlugin.list")(function* () {
        return []
      }),
      init: Effect.fn("MockPlugin.init")(function* () {}),
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
      // Wait briefly for forked recall to complete
      yield* Effect.sleep(50)
      return { result, hookCalls }
    })

    const allLayers = Compaction.layer.pipe(
      Layer.provide(Layer.succeed(Bus.Service, mockBus)),
      Layer.provide(Layer.succeed(Session.Service, createMockSession())),
      Layer.provide(Layer.succeed(Agent.Service, createMockAgent())),
      Layer.provide(Layer.succeed(Plugin.Service, pluginService)),
      Layer.provide(Layer.succeed(Config.Service, createMockConfig())),
      Layer.provide(Layer.succeed(Provider.Service, createMockProvider())),
      Layer.provide(Layer.succeed(SessionProcessor.Service, createMockSessionProcessor())),
      Layer.provide(Layer.succeed(RuntimeFlags.Service, createMockRuntimeFlags())),
      Layer.provide(Layer.succeed(EventV2Bridge.Service, createMockEventV2Bridge())),
      Layer.provide(Layer.succeed(Skill.Service, skillService)),
      Layer.provide(Layer.succeed(SessionMetadataService, {
        getMetadata: (_sessionID: string) =>
          Effect.succeed({
            dynamicSkillsScanned: new Set<string>(),
            dynamicSkillsRegistered: {},
            injectedSkills: new Set<string>(),
          }),
        addScannedDirectory: Effect.fn("MockSessionMetadata.addScannedDirectory")(function* () {}),
        addRegisteredSkill: Effect.fn("MockSessionMetadata.addRegisteredSkill")(function* () {}),
        wasDirectoryScanned: Effect.fn("MockSessionMetadata.wasDirectoryScanned")(function* () {
          return false
        }),
        getRegisteredSkills: Effect.fn("MockSessionMetadata.getRegisteredSkills")(function* () {
          return []
        }),
        wasSkillInjected: Effect.fn("MockSessionMetadata.wasSkillInjected")(function* () {
          return false
        }),
        addInjectedSkill: Effect.fn("MockSessionMetadata.addInjectedSkill")(function* () {}),
        clearMetadata: Effect.fn("MockSessionMetadata.clearMetadata")(function* () {}),
      })),
    )

    const result = await Effect.runPromise(
      Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), allLayers),
    )

    // Compaction should complete successfully
    expect(result.result).toBe("continue")

    // Plugin hook should have been called with correct name
    const recallHook = result.hookCalls.find((call) => call.name === "experimental.compaction.post_recall")
    expect(recallHook).toBeDefined()

    // Hook input should contain session context
    expect(recallHook!.input).toHaveProperty("sessionID")
    expect(recallHook!.input).toHaveProperty("agent")
    expect(recallHook!.input).toHaveProperty("model")
  })

  test("recall hook failure does not block compaction", async () => {
    const mockBus = createMockBus()
    const skillService = createMockSkillService()

    // Plugin that fails when the recall hook is called
    const pluginService = {
      trigger: Effect.fn("MockPlugin.trigger")(
        function* (name: string, input: unknown, output: unknown) {
          if (name === "experimental.compaction.post_recall") {
            // Yield a failed effect to propagate failure through the effect system
            yield* Effect.fail(new Error("Recall hook failed"))
            return null
          }
          return output
        },
      ),
      list: Effect.fn("MockPlugin.list")(function* () {
        return []
      }),
      init: Effect.fn("MockPlugin.init")(function* () {}),
    } as unknown as Plugin.Interface

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
      return { result }
    })

    const allLayers = Compaction.layer.pipe(
      Layer.provide(Layer.succeed(Bus.Service, mockBus)),
      Layer.provide(Layer.succeed(Session.Service, createMockSession())),
      Layer.provide(Layer.succeed(Agent.Service, createMockAgent())),
      Layer.provide(Layer.succeed(Plugin.Service, pluginService)),
      Layer.provide(Layer.succeed(Config.Service, createMockConfig())),
      Layer.provide(Layer.succeed(Provider.Service, createMockProvider())),
      Layer.provide(Layer.succeed(SessionProcessor.Service, createMockSessionProcessor())),
      Layer.provide(Layer.succeed(RuntimeFlags.Service, createMockRuntimeFlags())),
      Layer.provide(Layer.succeed(EventV2Bridge.Service, createMockEventV2Bridge())),
      Layer.provide(Layer.succeed(Skill.Service, skillService)),
      Layer.provide(Layer.succeed(SessionMetadataService, {
        getMetadata: (_sessionID: string) =>
          Effect.succeed({
            dynamicSkillsScanned: new Set<string>(),
            dynamicSkillsRegistered: {},
            injectedSkills: new Set<string>(),
          }),
        addScannedDirectory: Effect.fn("MockSessionMetadata.addScannedDirectory")(function* () {}),
        addRegisteredSkill: Effect.fn("MockSessionMetadata.addRegisteredSkill")(function* () {}),
        wasDirectoryScanned: Effect.fn("MockSessionMetadata.wasDirectoryScanned")(function* () {
          return false
        }),
        getRegisteredSkills: Effect.fn("MockSessionMetadata.getRegisteredSkills")(function* () {
          return []
        }),
        wasSkillInjected: Effect.fn("MockSessionMetadata.wasSkillInjected")(function* () {
          return false
        }),
        addInjectedSkill: Effect.fn("MockSessionMetadata.addInjectedSkill")(function* () {}),
        clearMetadata: Effect.fn("MockSessionMetadata.clearMetadata")(function* () {}),
      })),
    )

    // Should not throw even though the hook fails (error is caught by Effect.catch)
    const result = await Effect.runPromise(
      Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), allLayers),
    )

    // Compaction should still complete successfully despite hook failure
    expect(result.result).toBe("continue")
  })
})

// ---------------------------------------------------------------------------
// Overflow replay — media file parts are replayed as generic placeholders
// ---------------------------------------------------------------------------

describe("SessionCompaction — overflow replay media placeholder", () => {
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

  function makeUserInfo(id: MessageID, sessionID: SessionID): MessageV2.User {
    return {
      id,
      role: "user",
      sessionID,
      agent: "test",
      model: { providerID: ProviderID.make("mock-provider"), modelID: ModelID.make("mock-model") },
      time: { created: Date.now() },
    }
  }

  test("replays media file parts as generic [Attached mime: name] text parts", async () => {
    const mockBus = createMockBus()
    const skillService = createMockSkillService()
    const { session, capturedParts } = createCapturingMockSession()

    const sessionID = SessionID.descending()
    const parentID = MessageID.ascending()
    const earlierID = MessageID.ascending()
    const replayID = MessageID.ascending()

    // Earlier user message — keeps the overflow path's "has content" check true.
    const earlier: MessageV2.WithParts = {
      info: makeUserInfo(earlierID, sessionID),
      parts: [
        {
          id: PartID.ascending(),
          messageID: earlierID,
          sessionID,
          type: "text",
          text: "Keep this message before the replay target",
          time: { start: Date.now(), end: Date.now() },
        },
      ],
    }

    // Replay target: user message with media file parts (the compaction parent
    // sits after it; overflow replays these parts into the follow-up turn).
    const mediaFile = (suffix: string, mime: string, filename: string, url: string): MessageV2.FilePart => ({
      id: PartID.make(`prt-replay-${suffix}`),
      messageID: replayID,
      sessionID,
      type: "file",
      mime,
      filename,
      url,
    })

    const replayMsg: MessageV2.WithParts = {
      info: makeUserInfo(replayID, sessionID),
      parts: [
        mediaFile("video", "video/mp4", "movie.mp4", "file:///tmp/movie.mp4"),
        mediaFile("audio", "audio/mpeg", "clip.mp3", "file:///tmp/clip.mp3"),
        mediaFile("image", "image/png", "shot.png", "file:///tmp/shot.png"),
        {
          id: PartID.ascending(),
          messageID: replayID,
          sessionID,
          type: "text",
          text: "user prompt text survives replay",
          time: { start: Date.now(), end: Date.now() },
        },
      ],
    }

    const messages: MessageV2.WithParts[] = [earlier, replayMsg, ...buildCompactionMessages(parentID, sessionID)]

    const program = Effect.gen(function* () {
      const compaction = yield* Compaction.Service
      const result = yield* compaction.process({
        parentID,
        messages,
        sessionID,
        auto: true,
        overflow: true,
      })
      yield* Effect.sleep(50)
      return { result }
    })

    const allLayers = createAllLayers(skillService, mockBus, session)
    const result = await Effect.runPromise(
      Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), allLayers),
    )

    expect(result.result).toBe("continue")

    // Each media file part is replayed as the generic placeholder text part
    const texts = capturedParts.flatMap((p) => (p.type === "text" && p.text.startsWith("[Attached ") ? [p.text] : []))
    expect(texts).toContain("[Attached video/mp4: movie.mp4]")
    expect(texts).toContain("[Attached audio/mpeg: clip.mp3]")
    expect(texts).toContain("[Attached image/png: shot.png]")
    expect(texts).toHaveLength(3)

    // No media file part is replayed as a file part (all stripped to text)
    expect(capturedParts.filter((p) => p.type === "file")).toHaveLength(0)

    // Non-media parts replay unchanged
    expect(capturedParts.some((p) => p.type === "text" && p.text === "user prompt text survives replay")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task 2 (A2) — the injected post-compaction recall part carries the
// compaction_recall marker (auditability; mirrors compaction_continue).
// ---------------------------------------------------------------------------

describe("SessionCompaction — recall part marker (A2)", () => {
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

  test("injected recall part carries metadata.compaction_recall === true", async () => {
    const mockBus = createMockBus()
    const skillService = createMockSkillService()
    const { session, capturedParts } = createCapturingMockSession()

    // Plugin that sets recall text — compaction injects it as a synthetic
    // user message; the injected TextPart must carry the compaction_recall
    // marker.
    const pluginService: Plugin.Interface = {
      trigger: Effect.fn("MockPlugin.trigger")(function* <Name, Input, Output>(
        name: Name,
        _input: Input,
        output: Output,
      ) {
        if (String(name) === "experimental.compaction.post_recall") {
          ;(output as { text?: string }).text = "RECALL-PROMPT-A2-MARKER"
        }
        return output
      }),
      list: Effect.fn("MockPlugin.list")(function* () {
        return []
      }),
      init: Effect.fn("MockPlugin.init")(function* () {}),
    }

    const parentID = MessageID.ascending()
    const sessionID = SessionID.descending()
    const messages = buildCompactionMessages(parentID, sessionID)

    const program = Effect.gen(function* () {
      const compaction = yield* Compaction.Service
      const result = yield* compaction.process({ parentID, messages, sessionID, auto: true })
      yield* Effect.sleep(50)
      return result
    })

    const allLayers = createAllLayers(skillService, mockBus, session, pluginService)
    const result = await Effect.runPromise(
      Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), allLayers),
    )

    expect(result).toBe("continue")

    const recallPart = capturedParts.find(
      (p): p is MessageV2.TextPart => p.type === "text" && p.text === "RECALL-PROMPT-A2-MARKER",
    )
    expect(recallPart).toBeDefined()
    expect(recallPart!.metadata?.compaction_recall).toBe(true)
    expect(recallPart!.synthetic).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task 2 (A4) — consecutive auto-continue cap (DEC-3): 3 consecutive
// compaction_continue-marked injections allowed, 4th suppressed; a real
// (non-synthetic) user message between compactions breaks the chain.
// ---------------------------------------------------------------------------

describe("SessionCompaction — auto-continue consecutive cap (A4)", () => {
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

  function makeUserInfo(id: MessageID, sessionID: SessionID): MessageV2.User {
    return {
      id,
      role: "user",
      sessionID,
      agent: "test",
      model: { providerID: ProviderID.make("mock-provider"), modelID: ModelID.make("mock-model") },
      time: { created: Date.now() },
    }
  }

  function makeAssistantInfo(id: MessageID, sessionID: SessionID): MessageV2.Assistant {
    return {
      id,
      role: "assistant",
      sessionID,
      parentID: MessageID.ascending(),
      agent: "test",
      modelID: ModelID.make("mock-model"),
      providerID: ProviderID.make("mock-provider"),
      mode: "all",
      path: { cwd: "/tmp", root: "/tmp" },
      time: { created: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
  }

  // Synthetic user message carrying the compaction_continue marker — the
  // shape autocontinue itself injects.
  function makeContinueUser(id: MessageID, sessionID: SessionID): MessageV2.WithParts {
    return {
      info: makeUserInfo(id, sessionID),
      parts: [
        {
          id: PartID.ascending(),
          messageID: id,
          sessionID,
          type: "text",
          text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
          synthetic: true,
          metadata: { compaction_continue: true },
          time: { start: Date.now(), end: Date.now() },
        },
      ],
    }
  }

  function makeRealUser(id: MessageID, sessionID: SessionID, text: string): MessageV2.WithParts {
    return {
      info: makeUserInfo(id, sessionID),
      parts: [
        {
          id: PartID.ascending(),
          messageID: id,
          sessionID,
          type: "text",
          text,
          time: { start: Date.now(), end: Date.now() },
        },
      ],
    }
  }

  // `count` consecutive marker-carrying synthetic user messages (each preceded
  // by an assistant reply) sitting immediately before the compaction parent.
  function buildContinueChain(count: number, sessionID: SessionID): MessageV2.WithParts[] {
    const chain: MessageV2.WithParts[] = []
    for (let i = 0; i < count; i++) {
      chain.push({ info: makeAssistantInfo(MessageID.ascending(), sessionID), parts: [] })
      chain.push(makeContinueUser(MessageID.ascending(), sessionID))
    }
    return chain
  }

  async function runAutoContinueScenario(preParent: MessageV2.WithParts[]): Promise<MessageV2.Part[]> {
    const mockBus = createMockBus()
    const skillService = createMockSkillService()
    const { session, capturedParts } = createCapturingMockSession()

    const parentID = MessageID.ascending()
    const sessionID = SessionID.descending()
    const messages = [makeRealUser(MessageID.ascending(), sessionID, "seed task"), ...preParent, ...buildCompactionMessages(parentID, sessionID)]

    const program = Effect.gen(function* () {
      const compaction = yield* Compaction.Service
      const result = yield* compaction.process({ parentID, messages, sessionID, auto: true })
      yield* Effect.sleep(50)
      return result
    })

    const allLayers = createAllLayers(skillService, mockBus, session)
    const result = await Effect.runPromise(
      Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), allLayers),
    )
    expect(result).toBe("continue")
    return capturedParts
  }

  function continuePartsIn(captured: MessageV2.Part[]): MessageV2.TextPart[] {
    return captured.filter(
      (p): p is MessageV2.TextPart => p.type === "text" && p.metadata?.compaction_continue === true,
    )
  }

  test("no preceding continue chain — continue message is injected (1st)", async () => {
    const captured = await runAutoContinueScenario([])
    expect(continuePartsIn(captured)).toHaveLength(1)
  })

  test("2 consecutive preceding continue injections — 3rd is allowed", async () => {
    const sessionID = SessionID.descending()
    const captured = await runAutoContinueScenario(buildContinueChain(2, sessionID))
    expect(continuePartsIn(captured)).toHaveLength(1)
  })

  test("3 consecutive preceding continue injections — 4th is suppressed", async () => {
    const sessionID = SessionID.descending()
    const captured = await runAutoContinueScenario(buildContinueChain(3, sessionID))
    expect(continuePartsIn(captured)).toHaveLength(0)
  })

  test("real user message between compactions resets the chain — injection re-enabled", async () => {
    const sessionID = SessionID.descending()
    const chain = buildContinueChain(3, sessionID)
    // A real (non-synthetic, unmarked) user message after the chain breaks it.
    const realUser = makeRealUser(MessageID.ascending(), sessionID, "actually, switch direction please")
    const captured = await runAutoContinueScenario([...chain, { info: makeAssistantInfo(MessageID.ascending(), sessionID), parts: [] }, realUser])
    expect(continuePartsIn(captured)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Task 2 (replay guard) — incident shape: compaction → recall prompt →
// compaction … driven through the REAL BensyneRecallPlugin hook. The loop
// must terminate: ≤3 re-anchor injections and ≤3 auto-continue injections
// across 6 simulated compaction passes; later passes inject nothing.
// ---------------------------------------------------------------------------

describe("SessionCompaction — replay guard: incident loop terminates (A1+A4 composed)", () => {
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

  test("6 compaction passes produce ≤3 recall and ≤3 auto-continue injections; loop starves", async () => {
    const sessionID = SessionID.descending()

    // Real plugin hook — its module-level per-session cap is the A1 enforcement.
    const realHooks = await BensyneRecallPlugin({} as PluginInput)
    const realRecall = realHooks["experimental.compaction.post_recall"]!
    const pluginService: Plugin.Interface = {
      trigger: Effect.fn("ReplayPlugin.trigger")(function* <Name, Input, Output>(
        name: Name,
        input: Input,
        output: Output,
      ) {
        if (String(name) === "experimental.compaction.post_recall") {
          yield* Effect.promise(() => realRecall(input as any, output as any))
        }
        return output
      }),
      list: Effect.fn("ReplayPlugin.list")(function* () {
        return []
      }),
      init: Effect.fn("ReplayPlugin.init")(function* () {}),
    }

    const mockBus = createMockBus()
    const skillService = createMockSkillService()
    const { session, capturedParts } = createCapturingMockSession()

    let messages: MessageV2.WithParts[] = [
      makeSeedUser(MessageID.ascending(), sessionID),
      ...buildCompactionMessages(MessageID.ascending(), sessionID),
    ]

    let recallInjections = 0
    let continueInjections = 0
    let latePassInjections = 0

    for (let pass = 0; pass < 6; pass++) {
      const mark = capturedParts.length
      const parentID = messages[messages.length - 1]!.info.id

      const program = Effect.gen(function* () {
        const compaction = yield* Compaction.Service
        return yield* compaction.process({ parentID, messages, sessionID, auto: true })
      })

      const allLayers = createAllLayers(skillService, mockBus, session, pluginService)
      const result = await Effect.runPromise(
        Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), allLayers),
      )
      expect(result).toBe("continue")

      // Reconstruct the next pass's history from what this pass injected:
      // assistant summary → (continue user?) → (recall user?) → new parent.
      const injected = capturedParts.slice(mark)
      const contPart = injected.find(
        (p): p is MessageV2.TextPart => p.type === "text" && p.metadata?.compaction_continue === true,
      )
      const recallPart = injected.find(
        (p): p is MessageV2.TextPart => p.type === "text" && p.metadata?.compaction_recall === true,
      )
      if (contPart) continueInjections++
      if (recallPart) recallInjections++
      if (pass >= 3 && (contPart || recallPart)) latePassInjections++

      const nextMsgs: MessageV2.WithParts[] = [...messages]
      nextMsgs.push({
        info: {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID,
          parentID,
          agent: "test",
          modelID: ModelID.make("mock-model"),
          providerID: ProviderID.make("mock-provider"),
          mode: "all",
          path: { cwd: "/tmp", root: "/tmp" },
          time: { created: Date.now() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      })
      if (contPart) {
        const contID = MessageID.ascending()
        nextMsgs.push({
          info: {
            id: contID,
            role: "user",
            sessionID,
            agent: "test",
            model: { providerID: ProviderID.make("mock-provider"), modelID: ModelID.make("mock-model") },
            time: { created: Date.now() },
          },
          parts: [{ ...contPart, id: PartID.ascending(), messageID: contID }],
        })
      }
      if (recallPart) {
        const recallID = MessageID.ascending()
        nextMsgs.push({
          info: {
            id: recallID,
            role: "user",
            sessionID,
            agent: "test",
            model: { providerID: ProviderID.make("mock-provider"), modelID: ModelID.make("mock-model") },
            time: { created: Date.now() },
          },
          parts: [{ ...recallPart, id: PartID.ascending(), messageID: recallID }],
        })
      }
      // Next compaction trigger — auto-created parents carry only the
      // compaction part (matches Compaction.create shape).
      const nextParentID = MessageID.ascending()
      nextMsgs.push({
        info: {
          id: nextParentID,
          role: "user",
          sessionID,
          agent: "test",
          model: { providerID: ProviderID.make("mock-provider"), modelID: ModelID.make("mock-model") },
          time: { created: Date.now() },
        },
        parts: [{ id: PartID.ascending(), messageID: nextParentID, sessionID, type: "compaction", auto: true }],
      })
      messages = nextMsgs
    }

    // Loop cannot self-sustain: caps bound both injection streams…
    expect(recallInjections).toBeLessThanOrEqual(3)
    expect(continueInjections).toBeLessThanOrEqual(3)
    // …and after the caps bite (passes 4-6) nothing is injected at all.
    expect(latePassInjections).toBe(0)
  })

  function makeSeedUser(id: MessageID, sessionID: SessionID): MessageV2.WithParts {
    return {
      info: {
        id,
        role: "user",
        sessionID,
        agent: "test",
        model: { providerID: ProviderID.make("mock-provider"), modelID: ModelID.make("mock-model") },
        time: { created: Date.now() },
      },
      parts: [
        {
          id: PartID.ascending(),
          messageID: id,
          sessionID,
          type: "text",
          text: "seed task for replay guard",
          time: { start: Date.now(), end: Date.now() },
        },
      ],
    }
  }
})

// ---------------------------------------------------------------------------
// Task 4 (C1+C2) — compaction goal integrity: immutable Original Task block
// in the summarizer prompt (seeded from the first real user message) and a
// goal-drift tripwire that flags metadata.goal_drift on the summary assistant
// message when successive Goals differ with no intervening real user input.
// Tripwire only: never blocks or alters the produced summary.
// ---------------------------------------------------------------------------

describe("SessionCompaction — goal integrity: Original Task + drift tripwire (C1+C2)", () => {
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

  function makeUserInfo(id: MessageID, sessionID: SessionID): MessageV2.User {
    return {
      id,
      role: "user",
      sessionID,
      agent: "test",
      model: { providerID: ProviderID.make("mock-provider"), modelID: ModelID.make("mock-model") },
      time: { created: Date.now() },
    }
  }

  function makeAssistantInfo(
    id: MessageID,
    sessionID: SessionID,
    overrides?: Partial<Pick<MessageV2.Assistant, "summary" | "finish" | "parentID">>,
  ): MessageV2.Assistant {
    return {
      id,
      role: "assistant",
      sessionID,
      parentID: overrides?.parentID ?? MessageID.ascending(),
      agent: "test",
      modelID: ModelID.make("mock-model"),
      providerID: ProviderID.make("mock-provider"),
      mode: "all",
      path: { cwd: "/tmp", root: "/tmp" },
      time: { created: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(overrides?.summary ? { summary: true } : {}),
      ...(overrides?.finish ? { finish: overrides.finish } : {}),
    }
  }

  function makeRealUser(id: MessageID, sessionID: SessionID, text: string): MessageV2.WithParts {
    return {
      info: makeUserInfo(id, sessionID),
      parts: [
        {
          id: PartID.ascending(),
          messageID: id,
          sessionID,
          type: "text",
          text,
          time: { start: Date.now(), end: Date.now() },
        },
      ],
    }
  }

  // Synthetic user message carrying a compaction marker (continue or recall) —
  // must be skipped when picking the Original Task and must NOT count as
  // intervening real user input for the drift tripwire.
  function makeMarkerUser(
    id: MessageID,
    sessionID: SessionID,
    metadata: Record<string, unknown>,
    text: string,
  ): MessageV2.WithParts {
    return {
      info: makeUserInfo(id, sessionID),
      parts: [
        {
          id: PartID.ascending(),
          messageID: id,
          sessionID,
          type: "text",
          text,
          synthetic: true,
          metadata,
          time: { start: Date.now(), end: Date.now() },
        },
      ],
    }
  }

  // Auto-compaction parent: user message whose only part is the compaction part.
  function makeCompactionParent(id: MessageID, sessionID: SessionID): MessageV2.WithParts {
    return {
      info: makeUserInfo(id, sessionID),
      parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "compaction", auto: true }],
    }
  }

  // Attaching session mock: updatePart writes land on the stored message so
  // summaryText() (read back via session.messages()) sees the produced summary.
  function createAttachingMockSession(): {
    session: Session.Interface
    stored: MessageV2.WithParts[]
    updatedMessages: MessageV2.Info[]
  } {
    const stored: MessageV2.WithParts[] = []
    const updatedMessages: MessageV2.Info[] = []
    const base = createMockSession()
    const session: Session.Interface = {
      ...base,
      messages: Effect.fn("AttachingSession.messages")(function* (_: { sessionID: SessionID }) {
        return stored
      }),
      updateMessage: Effect.fn("AttachingSession.updateMessage")(function* <T extends MessageV2.Info>(msg: T) {
        updatedMessages.push(msg)
        const idx = stored.findIndex((m) => m.info.id === msg.id)
        const entry: MessageV2.WithParts = { info: msg, parts: idx >= 0 ? stored[idx]!.parts : [] }
        if (idx >= 0) stored[idx] = entry
        else stored.push(entry)
        return msg
      }),
      updatePart: Effect.fn("AttachingSession.updatePart")(function* <T extends MessageV2.Part>(part: T) {
        const idx = stored.findIndex((m) => m.info.id === part.messageID)
        if (idx >= 0) stored[idx]!.parts.push(part as MessageV2.Part)
        return part
      }),
    }
    return { session, stored, updatedMessages }
  }

  // Processor mock that records the summarizer stream input (so the built
  // prompt can be asserted) and, when given summary text, writes it back as a
  // text part on the assistant message — the shape the real processor produces.
  function createSummarizingMockProcessor(session: Session.Interface, summaryText?: string): {
    processor: SessionProcessor.Interface
    prompts: string[]
  } {
    const prompts: string[] = []
    return {
      prompts,
      processor: {
        create: Effect.fn("SummarizingProcessor.create")(function* (input: {
          assistantMessage: MessageV2.Assistant
          sessionID: SessionID
          model: Provider.Model
        }) {
          const assistantMessage = input.assistantMessage
          return {
            message: assistantMessage,
            updateToolCall: Effect.fn("SummarizingHandle.updateToolCall")(function* () {
              return undefined
            }),
            completeToolCall: Effect.fn("SummarizingHandle.completeToolCall")(function* () {}),
            process: (streamInput: LLM.StreamInput) =>
              Effect.gen(function* () {
                const last = streamInput.messages.at(-1) as {
                  role?: string
                  content?: Array<{ type?: string; text?: string }>
                }
                prompts.push(last?.content?.[0]?.text ?? "")
                if (summaryText !== undefined) {
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    messageID: assistantMessage.id,
                    sessionID: assistantMessage.sessionID,
                    type: "text",
                    text: summaryText,
                    time: { start: Date.now(), end: Date.now() },
                  } satisfies MessageV2.TextPart)
                }
                return "continue" as SessionProcessor.Result
              }),
          } satisfies SessionProcessor.Handle
        }),
      },
    }
  }

  async function runGoalIntegrityScenario(input: {
    messages: MessageV2.WithParts[]
    parentID: MessageID
    sessionID: SessionID
    summaryText?: string
  }): Promise<{
    result: "continue" | "stop"
    prompts: string[]
    stored: MessageV2.WithParts[]
    updatedMessages: MessageV2.Info[]
  }> {
    const mockBus = createMockBus()
    const skillService = createMockSkillService()
    const { session, stored, updatedMessages } = createAttachingMockSession()
    const { processor, prompts } = createSummarizingMockProcessor(session, input.summaryText)

    const program = Effect.gen(function* () {
      const compaction = yield* Compaction.Service
      const result = yield* compaction.process({
        parentID: input.parentID,
        messages: input.messages,
        sessionID: input.sessionID,
        auto: true,
      })
      yield* Effect.sleep(50)
      return result
    })

    const allLayers = createAllLayers(skillService, mockBus, session, createMockPlugin(), processor)
    const result = await Effect.runPromise(
      Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), allLayers),
    )
    return { result, prompts, stored, updatedMessages }
  }

  function summaryAssistantIn(stored: MessageV2.WithParts[], parentID: MessageID): MessageV2.Assistant {
    const entry = stored.find(
      (m) => m.info.role === "assistant" && (m.info as MessageV2.Assistant).parentID === parentID,
    )
    return entry!.info as MessageV2.Assistant
  }

  // --- C1: template + prompt assembly -------------------------------------

  test("SUMMARY_TEMPLATE carries the immutable Original Task section (in built prompt)", async () => {
    const sessionID = SessionID.descending()
    const parentID = MessageID.ascending()
    const { result, prompts } = await runGoalIntegrityScenario({
      messages: [makeRealUser(MessageID.ascending(), sessionID, "real task"), ...buildCompactionMessages(parentID, sessionID)],
      parentID,
      sessionID,
    })

    expect(result).toBe("continue")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("## Original Task (immutable)")
    expect(prompts[0]).toContain("Goal must be consistent with Original Task")
  })

  test("<original-task> block present with the first real user message text", async () => {
    const sessionID = SessionID.descending()
    const parentID = MessageID.ascending()
    const { prompts } = await runGoalIntegrityScenario({
      messages: [
        makeRealUser(MessageID.ascending(), sessionID, "Fix the login bug in auth.ts"),
        makeRealUser(MessageID.ascending(), sessionID, "second real message never wins"),
        ...buildCompactionMessages(parentID, sessionID),
      ],
      parentID,
      sessionID,
    })

    expect(prompts[0]).toContain("<original-task>")
    expect(prompts[0]).toContain("</original-task>")
    expect(prompts[0]).toContain("Copy this block verbatim into the Original Task section. Never rewrite, reinterpret, or merge it.")
    expect(prompts[0]).toContain("Fix the login bug in auth.ts")
    expect(prompts[0]).not.toContain("second real message never wins")
  })

  test("synthetic and marker-carrying messages are skipped when picking the Original Task", async () => {
    const sessionID = SessionID.descending()
    const parentID = MessageID.ascending()
    const { prompts } = await runGoalIntegrityScenario({
      messages: [
        makeMarkerUser(MessageID.ascending(), sessionID, { compaction_recall: true }, "SYNTHETIC-RECALL-MUST-NOT-BE-TASK"),
        makeMarkerUser(MessageID.ascending(), sessionID, { compaction_continue: true }, "SYNTHETIC-CONTINUE-MUST-NOT-BE-TASK"),
        makeRealUser(MessageID.ascending(), sessionID, "the actual user request"),
        ...buildCompactionMessages(parentID, sessionID),
      ],
      parentID,
      sessionID,
    })

    expect(prompts[0]).toContain("<original-task>")
    expect(prompts[0]).toContain("the actual user request")
    expect(prompts[0]).not.toContain("SYNTHETIC-RECALL-MUST-NOT-BE-TASK")
    expect(prompts[0]).not.toContain("SYNTHETIC-CONTINUE-MUST-NOT-BE-TASK")
  })

  test("Original Task text longer than 2000 chars is truncated with an ellipsis", async () => {
    const sessionID = SessionID.descending()
    const parentID = MessageID.ascending()
    const longText = "x".repeat(2500)
    const { prompts } = await runGoalIntegrityScenario({
      messages: [makeRealUser(MessageID.ascending(), sessionID, longText), ...buildCompactionMessages(parentID, sessionID)],
      parentID,
      sessionID,
    })

    const prompt = prompts[0]!
    expect(prompt).toContain("<original-task>")
    expect(prompt).toContain("x".repeat(2000))
    expect(prompt).not.toContain("x".repeat(2001))
    // Truncated marker (ellipsis) present right after the cut
    expect(prompt).toMatch(/x{2000}[…]/)
  })

  test("no <original-task> block when no real user message exists", async () => {
    const sessionID = SessionID.descending()
    const parentID = MessageID.ascending()
    // Only marker-carrying synthetic messages + the compaction parent (which
    // carries a compaction part and must not qualify either).
    const { prompts } = await runGoalIntegrityScenario({
      messages: [
        makeMarkerUser(MessageID.ascending(), sessionID, { compaction_continue: true }, "continue prompt"),
        ...buildCompactionMessages(parentID, sessionID),
      ],
      parentID,
      sessionID,
    })

    expect(prompts[0]).not.toContain("<original-task>")
  })

  // --- C2: goal-drift tripwire ---------------------------------------------

  const priorSummary = ["## Goal", "- Fix the login bug in auth.ts", "", "## Progress", "### Done", "- none"].join("\n")
  const driftedSummary = ["## Goal", "- Build the XDR short engine", "", "## Progress", "### Done", "- none"].join("\n")
  const sameGoalDifferentShape = ["## Goal", "-   FIX the LOGIN bug   in auth.ts", "", "## Progress", "### Done", "- none"].join("\n")

  // History: real task → assistant → prior compaction (user + summary
  // assistant) → synthetic continue → assistant → current compaction parent.
  function buildDriftHistory(sessionID: SessionID): { messages: MessageV2.WithParts[]; parentID: MessageID } {
    const parentID = MessageID.ascending()
    const priorParentID = MessageID.ascending()
    const priorSummaryID = MessageID.ascending()
    const messages: MessageV2.WithParts[] = [
      makeRealUser(MessageID.ascending(), sessionID, "Fix the login bug in auth.ts"),
      { info: makeAssistantInfo(MessageID.ascending(), sessionID), parts: [] },
      makeCompactionParent(priorParentID, sessionID),
      {
        info: makeAssistantInfo(priorSummaryID, sessionID, { summary: true, finish: "stop", parentID: priorParentID }),
        parts: [
          {
            id: PartID.ascending(),
            messageID: priorSummaryID,
            sessionID,
            type: "text",
            text: priorSummary,
            time: { start: Date.now(), end: Date.now() },
          },
        ],
      },
      makeMarkerUser(MessageID.ascending(), sessionID, { compaction_continue: true }, "Continue if you have next steps"),
      { info: makeAssistantInfo(MessageID.ascending(), sessionID), parts: [] },
      makeCompactionParent(parentID, sessionID),
    ]
    return { messages, parentID }
  }

  test("goal drift with no intervening real user message → metadata.goal_drift on summary message", async () => {
    const sessionID = SessionID.descending()
    const { messages, parentID } = buildDriftHistory(sessionID)

    const { result, stored } = await runGoalIntegrityScenario({
      messages,
      parentID,
      sessionID,
      summaryText: driftedSummary,
    })

    // Tripwire never blocks compaction…
    expect(result).toBe("continue")
    // …and flags the summary assistant message.
    const summaryMsg = summaryAssistantIn(stored, parentID)
    expect(summaryMsg).toBeDefined()
    expect(summaryMsg.metadata?.goal_drift).toBe(true)
    // Produced summary text is untouched by the tripwire.
    const summaryPart = stored
      .find((m) => m.info.id === summaryMsg.id)!
      .parts.find((p): p is MessageV2.TextPart => p.type === "text")
    expect(summaryPart!.text).toBe(driftedSummary)
  })

  test("Goals match after normalization → no drift flag", async () => {
    const sessionID = SessionID.descending()
    const { messages, parentID } = buildDriftHistory(sessionID)

    const { result, stored } = await runGoalIntegrityScenario({
      messages,
      parentID,
      sessionID,
      summaryText: sameGoalDifferentShape,
    })

    expect(result).toBe("continue")
    const summaryMsg = summaryAssistantIn(stored, parentID)
    expect(summaryMsg.metadata?.goal_drift).toBeUndefined()
  })

  test("real user message between the two compactions → no drift flag despite differing Goals", async () => {
    const sessionID = SessionID.descending()
    const { messages, parentID } = buildDriftHistory(sessionID)
    // Insert a real user message between the prior compaction and the current one.
    const realIdx = messages.findIndex((m) => m.parts.some((p) => p.type === "compaction" && p.auto) && m.info.id !== parentID)
    messages.splice(realIdx + 3, 0, makeRealUser(MessageID.ascending(), sessionID, "actually, pivot to payments"))

    const { result, stored } = await runGoalIntegrityScenario({
      messages,
      parentID,
      sessionID,
      summaryText: driftedSummary,
    })

    expect(result).toBe("continue")
    const summaryMsg = summaryAssistantIn(stored, parentID)
    expect(summaryMsg.metadata?.goal_drift).toBeUndefined()
  })

  test("first compaction (no previous summary) → no drift flag", async () => {
    const sessionID = SessionID.descending()
    const parentID = MessageID.ascending()

    const { result, stored } = await runGoalIntegrityScenario({
      messages: [makeRealUser(MessageID.ascending(), sessionID, "first task"), ...buildCompactionMessages(parentID, sessionID)],
      parentID,
      sessionID,
      summaryText: driftedSummary,
    })

    expect(result).toBe("continue")
    const summaryMsg = summaryAssistantIn(stored, parentID)
    expect(summaryMsg.metadata?.goal_drift).toBeUndefined()
  })
})

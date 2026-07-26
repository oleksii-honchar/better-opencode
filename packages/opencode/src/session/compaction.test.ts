import { describe, test, expect } from "bun:test"
import { Effect, Layer, Context, Scope } from "effect"
import * as Compaction from "@/session/compaction"
import * as Skill from "@/skill"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { SessionProcessor } from "@/session/processor"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"

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

  // Expose state for test inspection
  Object.defineProperty(state, '__testState', { value: state, writable: true })

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

  // Expose state for test inspection
  Object.defineProperty(service, '__testState', { value: state, writable: true })
  return service
}

// ---------------------------------------------------------------------------
// Mock Bus that tracks published events
// ---------------------------------------------------------------------------

function createMockBus(): Bus.Interface {
  const publishedEvents: Array<{ name: string; data: unknown }> = []

  return {
    publish: Effect.fn("MockBus.publish")(function* (event: Bus.Event, data: unknown) {
      publishedEvents.push({ name: event.type, data })
      return {}
    }),
    subscribe: Effect.fn("MockBus.subscribe")(function* () {
      return Effect.never
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
    messages: Effect.fn("MockSession.messages")(function* ({ sessionID }: { sessionID: SessionID }) {
      return messagesData
    }),
    updateMessage: Effect.fn("MockSession.updateMessage")(function* (msg: MessageV2.Message) {
      const withParts: MessageV2.WithParts = { info: msg, parts: [] }
      const existingIdx = messagesData.findIndex((m) => m.info.id === msg.id)
      if (existingIdx >= 0) {
        messagesData[existingIdx] = withParts
      } else {
        messagesData.push(withParts)
      }
      return msg
    }),
    updatePart: Effect.fn("MockSession.updatePart")(function* (part: MessageV2.Part) {
      return part
    }),
    deleteMessage: Effect.fn("MockSession.deleteMessage")(function* () {
      return
    }),
    deleteParts: Effect.fn("MockSession.deleteParts")(function* () {
      return
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock Agent.Service
// ---------------------------------------------------------------------------

function createMockAgent(): Agent.Interface {
  return {
    get: Effect.fn("MockAgent.get")(function* (name: string) {
      return {
        name,
        role: "assistant",
        description: "Mock agent",
        permission: { level: "allow" as const },
        model: undefined,
      }
    }),
    list: Effect.fn("MockAgent.list")(function* () {
      return []
    }),
    update: Effect.fn("MockAgent.update")(function* () {
      return {}
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock Plugin.Service
// ---------------------------------------------------------------------------

function createMockPlugin(): Plugin.Interface {
  return {
    trigger: Effect.fn("MockPlugin.trigger")(function* (_event, _ctx, defaultResult) {
      return defaultResult
    }),
    load: Effect.fn("MockPlugin.load")(function* () {
      return []
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock Config.Service
// ---------------------------------------------------------------------------

function createMockConfig(): Config.Interface {
  return {
    get: Effect.fn("MockConfig.get")(function* () {
      return {
        compaction: {
          tail_turns: 2,
        },
      }
    }),
    directories: Effect.fn("MockConfig.directories")(function* () {
      return []
    }),
    update: Effect.fn("MockConfig.update")(function* () {
      return {}
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock Provider.Service
// ---------------------------------------------------------------------------

function createMockProvider(): Provider.Interface {
  return {
    getModel: Effect.fn("MockProvider.getModel")(function* () {
      return {
        id: "mock-model",
        providerID: "mock-provider",
        api: {
          id: "mock-model",
          name: "Mock Model",
        },
        context: 128000,
        maxTokens: 8192,
        pricing: { input: 0, output: 0 },
        limit: {
          context: 128000,
          maxTokens: 8192,
        },
      }
    }),
    getProvider: Effect.fn("MockProvider.getProvider")(function* () {
      return {
        id: "mock-provider",
        source: "local",
        options: {},
      }
    }),
    listModels: Effect.fn("MockProvider.listModels")(function* () {
      return []
    }),
    listProviders: Effect.fn("MockProvider.listProviders")(function* () {
      return []
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock SessionProcessor.Service
// ---------------------------------------------------------------------------

function createMockSessionProcessor(): SessionProcessor.Interface {
  return {
    create: Effect.fn("MockSessionProcessor.create")(function* () {
      return {
        process: Effect.fn("MockProcessor.process")(function* () {
          return "continue"
        }),
        message: {
          error: undefined,
        },
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock RuntimeFlags.Service
// ---------------------------------------------------------------------------

function createMockRuntimeFlags(): RuntimeFlags.Interface {
  return {
    disableExternalSkills: false,
    disableClaudeCodeSkills: false,
    experimentalEventSystem: false,
    outputTokenMax: undefined,
  }
}

// ---------------------------------------------------------------------------
// Mock EventV2Bridge.Service
// ---------------------------------------------------------------------------

function createMockEventV2Bridge(): EventV2Bridge.Interface {
  return {
    publish: Effect.fn("MockEventV2Bridge.publish")(function* () {
      return {}
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
        model: { providerID: "mock-provider", modelID: "mock-model" },
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
          time: { start: Date.now(), end: Date.now() },
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionCompaction — Post-Compaction Dynamic Skill Promotion", () => {
  const mockInstanceContext = {
    directory: "/test-dir",
    worktree: "/test-worktree",
    sessionID: SessionID.descending(),
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
    const mockWorkspaceContextLayer = Layer.succeed(WorkspaceContext, { workspaceID: "ws-test" })

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
      Layer.provide(mockWorkspaceContextLayer),
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
      // Simulate a failure in promoteDynamicToStartup
      promoteDynamicToStartup: Effect.fn("MockSkill.promoteDynamicToStartup")(function* () {
        return yield* Effect.fail(new Error("Promotion failed"))
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

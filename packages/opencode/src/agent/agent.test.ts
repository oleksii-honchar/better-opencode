import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ConsoleState } from "@/config/console-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Skill } from "@/skill"
import type { LoopDetectedInfo } from "@/plugin/unstuck"

// ---------------------------------------------------------------------------
// Mock services — enough to boot the real Agent.layer and read the permission
// defaults built by Agent.state (the `defaults` object in agent.ts).
// ---------------------------------------------------------------------------

function createMockConfig(): Config.Interface {
  const mockInfo: Config.Info = { permission: {} }
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

function createMockAuth(): Auth.Interface {
  return {
    get: Effect.fn("MockAuth.get")(function* () {
      return undefined
    }),
    all: Effect.fn("MockAuth.all")(function* () {
      return {}
    }),
    set: Effect.fn("MockAuth.set")(function* () {}),
    remove: Effect.fn("MockAuth.remove")(function* () {}),
  }
}

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

function createMockSkill(): Skill.Interface {
  return {
    get: Effect.fn("MockSkill.get")(function* () {
      return undefined
    }),
    require: Effect.fn("MockSkill.require")(function* () {
      throw new Error("not found")
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
      return { promoted: 0 }
    }),
  }
}

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
  return {
    list: Effect.fn("MockProvider.list")(function* () {
      return { [mockProviderID]: { id: mockProviderID, name: "Mock", source: "config", env: [], options: {}, models: {} } }
    }),
    getProvider: Effect.fn("MockProvider.getProvider")(function* () {
      return { id: mockProviderID, name: "Mock", source: "config", env: [], options: {}, models: {} }
    }),
    getModel: Effect.fn("MockProvider.getModel")(function* () {
      return mockModel
    }),
    getLanguage: Effect.fn("MockProvider.getLanguage")(function* () {
      throw new Error("not implemented")
    }),
    closest: Effect.fn("MockProvider.closest")(function* () {
      return undefined
    }),
    getSmallModel: Effect.fn("MockProvider.getSmallModel")(function* () {
      return mockModel
    }),
    defaultModel: Effect.fn("MockProvider.defaultModel")(function* () {
      return { providerID: mockProviderID, modelID: mockModelID }
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

const mockLayers = Layer.mergeAll(
  Layer.succeed(Config.Service, createMockConfig()),
  Layer.succeed(Auth.Service, createMockAuth()),
  Layer.succeed(Plugin.Service, createMockPlugin()),
  Layer.succeed(Skill.Service, createMockSkill()),
  Layer.succeed(Provider.Service, createMockProvider()),
  Layer.succeed(RuntimeFlags.Service, createMockRuntimeFlags()),
)

describe("Agent — shared permission defaults", () => {
  test("doom_loop defaults to allow in the shared permission defaults", async () => {
    const general = await Effect.runPromise(
      Effect.provide(Agent.use.get("general"), Layer.provide(Agent.layer, mockLayers)),
    )

    const doomRule = general.permission.find((r) => r.permission === "doom_loop")
    expect(doomRule).toEqual({ permission: "doom_loop", action: "allow", pattern: "*" })
  })

  test("other shared permission defaults are untouched", async () => {
    const general = await Effect.runPromise(
      Effect.provide(Agent.use.get("general"), Layer.provide(Agent.layer, mockLayers)),
    )

    const rules = general.permission
    const ruleFor = (permission: string) => rules.find((r) => r.permission === permission)

    expect(ruleFor("*")?.action).toBe("allow")
    expect(ruleFor("question")?.action).toBe("deny")
    expect(ruleFor("plan_enter")?.action).toBe("deny")
    expect(ruleFor("plan_exit")?.action).toBe("deny")
    expect(ruleFor("repo_clone")?.action).toBe("deny")
    expect(ruleFor("repo_overview")?.action).toBe("deny")
  })
})

// Type-level check: the unstuck plugin index must export the doom_loop type
// variant so consumers can construct it without missing-export type errors.
describe("unstuck index — doom_loop type exports", () => {
  test("LoopDetectedInfo exported from the plugin index carries the doom_loop variant", () => {
    const info: LoopDetectedInfo = {
      type: "doom_loop",
      threshold: 3,
      toolName: "bash",
      fingerprint: "fp-1",
    }
    expect(info.type).toBe("doom_loop")
  })
})

// ---------------------------------------------------------------------------
// smartModels — per-agent provider-scoped smart models for in-flight switching
// ---------------------------------------------------------------------------

function createMockConfigWithSmartModels(): Config.Interface {
  const mockInfo: Config.Info = {
    permission: {},
    agent: {
      smartAgent: {
        name: "smartAgent",
        mode: "subagent",
        smartModels: ["p1/smart", "p2/smart"],
        options: {},
        permission: {},
      },
      noSmartAgent: {
        name: "noSmartAgent",
        mode: "subagent",
        options: {},
        permission: {},
      },
    },
  } as Config.Info
  return {
    get: Effect.fn("MockConfigSmart.get")(function* () {
      return mockInfo
    }),
    getGlobal: Effect.fn("MockConfigSmart.getGlobal")(function* () {
      return mockInfo
    }),
    getConsoleState: Effect.fn("MockConfigSmart.getConsoleState")(function* () {
      return ConsoleState.make({ consoleManagedProviders: [], switchableOrgCount: 0 })
    }),
    update: Effect.fn("MockConfigSmart.update")(function* () {}),
    updateGlobal: Effect.fn("MockConfigSmart.updateGlobal")(function* () {
      return { info: mockInfo, changed: false }
    }),
    invalidate: Effect.fn("MockConfigSmart.invalidate")(function* () {}),
    directories: Effect.fn("MockConfigSmart.directories")(function* () {
      return []
    }),
    waitForDependencies: Effect.fn("MockConfigSmart.waitForDependencies")(function* () {}),
  }
}

const smartModelMockLayers = Layer.mergeAll(
  Layer.succeed(Config.Service, createMockConfigWithSmartModels()),
  Layer.succeed(Auth.Service, createMockAuth()),
  Layer.succeed(Plugin.Service, createMockPlugin()),
  Layer.succeed(Skill.Service, createMockSkill()),
  Layer.succeed(Provider.Service, createMockProvider()),
  Layer.succeed(RuntimeFlags.Service, createMockRuntimeFlags()),
)

describe("Agent — smartModels parsing", () => {
  test("parses smartModels with provider/model format into structured entries", async () => {
    const agent = await Effect.runPromise(
      Effect.provide(Agent.use.get("smartAgent"), Layer.provide(Agent.layer, smartModelMockLayers)),
    )

    expect(agent.smartModels).toEqual([
      { providerID: ProviderID.make("p1"), modelID: ModelID.make("smart"), variant: undefined },
      { providerID: ProviderID.make("p2"), modelID: ModelID.make("smart"), variant: undefined },
    ])
  })

  test("smartModels is undefined when not configured (existing agents unaffected)", async () => {
    const agent = await Effect.runPromise(
      Effect.provide(Agent.use.get("noSmartAgent"), Layer.provide(Agent.layer, smartModelMockLayers)),
    )

    expect(agent.smartModels).toBeUndefined()
  })
})

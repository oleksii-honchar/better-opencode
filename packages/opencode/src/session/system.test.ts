import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as SystemPrompt from "@/session/system"
import * as Skill from "@/skill"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import type * as Project from "@/project/project"
import { ProjectID } from "@/project/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeModel(providerID: ProviderID): Provider.Model {
  return {
    id: ModelID.make("test-model"),
    providerID,
    api: { id: "test-model", url: "http://mock", npm: "mock" },
    name: "test-model",
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
}

function makeAgent(overrides: Partial<Agent.Info> = {}): Agent.Info {
  return {
    name: "test-agent",
    description: "Test agent",
    mode: "all",
    permission: [{ permission: "all", pattern: "*", action: "allow" as const }],
    options: {},
    ...overrides,
  }
}

// environment() does not call skill; the layer only requires the service to exist.
function makeSkillService(): Skill.Interface {
  return {
    get: Effect.fn("MockSkill.get")(function* (_name: string) {
      return undefined
    }),
    require: Effect.fn("MockSkill.require")(function* (name: string) {
      return yield* new Skill.NotFoundError({ name, available: [] })
    }),
    all: Effect.fn("MockSkill.all")(function* () {
      return []
    }),
    allIncludingDynamic: Effect.fn("MockSkill.allIncludingDynamic")(function* () {
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
      return { promoted: 0 }
    }),
  }
}

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

async function runEnvironment(model: Provider.Model, agent: Agent.Info, modelSwitchEnabled: boolean): Promise<string> {
  const program = Effect.gen(function* () {
    const sys = yield* SystemPrompt.Service
    const env = yield* sys.environment(model, undefined, undefined, undefined, agent, modelSwitchEnabled)
    return env.join("\n")
  })

  const layer = SystemPrompt.layer.pipe(Layer.provide(Layer.succeed(Skill.Service, makeSkillService())))

  return await Effect.runPromise(Effect.provide(Effect.provideService(program, InstanceRef, mockInstanceContext), layer))
}

const P1 = ProviderID.make("p1")
const P2 = ProviderID.make("p2")
const SMART_MODELS_2 = [
  { providerID: P1, modelID: ModelID.make("smart") },
  { providerID: P2, modelID: ModelID.make("smart") },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SystemPrompt.environment — smart-model list + switching guidance", () => {
  test("enabled + agent smartModels for current provider: lists matching models on SMART_MODELS line", async () => {
    const out = await runEnvironment(makeModel(P1), makeAgent({ smartModels: SMART_MODELS_2 }), true)
    // Only p1/smart should be listed (p2 filtered out)
    expect(out).toContain("SMART_MODELS: p1/smart")
    expect(out).not.toContain("p2/smart")
  })

  test("enabled + matching smart models: guidance present and mentions switch_model", async () => {
    const out = await runEnvironment(makeModel(P1), makeAgent({ smartModels: SMART_MODELS_2 }), true)
    expect(out).toContain("switch_model")
  })

  test("guidance states persist semantics: current turn only unless persist: true, then until user re-pin", async () => {
    const out = await runEnvironment(makeModel(P1), makeAgent({ smartModels: SMART_MODELS_2 }), true)
    expect(out).toContain("persist: true")
    expect(out).toContain("current turn only")
    expect(out).toContain("until the user re-pins")
    // RC4 root cause: the v1 "temporarily" wording was ambiguous about what
    // "temporarily" meant; it must not come back.
    expect(out).not.toContain("temporarily use a more capable model")
  })

  test("running on p2 model: SMART_MODELS lists only p2/smart", async () => {
    const out = await runEnvironment(makeModel(P2), makeAgent({ smartModels: SMART_MODELS_2 }), true)
    expect(out).toContain("SMART_MODELS: p2/smart")
    expect(out).not.toContain("p1/smart")
  })

  test("agent has no smartModels for current provider: neither list nor guidance appears", async () => {
    // Agent only has a smart model for p2; running on p1.
    const out = await runEnvironment(
      makeModel(P1),
      makeAgent({ smartModels: [{ providerID: P2, modelID: ModelID.make("smart") }] }),
      true,
    )
    expect(out).not.toContain("SMART_MODELS")
    expect(out).not.toContain("switch_model")
  })

  test("agent has no smartModels at all: neither list nor guidance appears", async () => {
    const out = await runEnvironment(makeModel(P1), makeAgent({}), true)
    expect(out).not.toContain("SMART_MODELS")
    expect(out).not.toContain("switch_model")
  })

  test("dynamicModelSwitch disabled: neither list nor guidance appears even with smart models", async () => {
    const out = await runEnvironment(makeModel(P1), makeAgent({ smartModels: SMART_MODELS_2 }), false)
    expect(out).not.toContain("SMART_MODELS")
    expect(out).not.toContain("switch_model")
  })

  test("existing environment content unchanged (header still present)", async () => {
    const out = await runEnvironment(makeModel(P1), makeAgent({ smartModels: SMART_MODELS_2 }), true)
    expect(out).toContain("Here is some useful information about the environment you are running in:")
  })
})

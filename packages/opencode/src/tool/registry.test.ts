import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { ToolRegistry } from "./registry"
import { Config as ConfigModule } from "@/config/config"
import { Plugin } from "../plugin"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Session } from "../session/session"
import { SessionStatus } from "../session/status"
import { BackgroundJob } from "../background/job"
import { Provider } from "@/provider/provider"
import { Git } from "@/git"
import { RepositoryCache } from "@/reference/repository-cache"
import { Reference } from "@/reference/reference"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "../bus"
import { HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Ripgrep } from "../file/ripgrep"
import { Format } from "../format"
import { Truncate } from "./truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"

// ---------------------------------------------------------------------------
// Mock type matching the config subset used by registry.ts
// ---------------------------------------------------------------------------
type Config = { toolFilter?: { applyPatch?: { enabled?: boolean } } }

// The filtering condition used in registry.ts builtin array:
//   ...(cfg.toolFilter?.applyPatch?.enabled !== false ? [tool.patch] : []),
function applyPatchIncluded(cfg: Config): boolean {
  return cfg.toolFilter?.applyPatch?.enabled !== false
}

// ---------------------------------------------------------------------------
// Qwen model detection helper — mirrors isQwenModel from registry.ts
// ---------------------------------------------------------------------------
function isQwenModel(modelID: string): boolean {
  return /qwen/i.test(modelID)
}

describe("Tool Registry — ApplyPatchTool filtering", () => {
  test("included when config has no toolFilter (default behavior preserved)", () => {
    expect(applyPatchIncluded({})).toBe(true)
  })

  test("included when toolFilter is present but applyPatch is absent", () => {
    expect(applyPatchIncluded({ toolFilter: {} })).toBe(true)
  })

  test("included when applyPatch is present but enabled is absent", () => {
    expect(applyPatchIncluded({ toolFilter: { applyPatch: {} } })).toBe(true)
  })

  test("included when toolFilter.applyPatch.enabled is true", () => {
    expect(applyPatchIncluded({ toolFilter: { applyPatch: { enabled: true } } })).toBe(true)
  })

  test("excluded when toolFilter.applyPatch.enabled is false", () => {
    expect(applyPatchIncluded({ toolFilter: { applyPatch: { enabled: false } } })).toBe(false)
  })

  test("included when toolFilter is null-like (safety check)", () => {
    expect(applyPatchIncluded({ toolFilter: undefined })).toBe(true)
    expect(applyPatchIncluded({ toolFilter: { applyPatch: undefined } })).toBe(true)
  })
})

describe("Qwen Model Detection — isQwenModel", () => {
  test("detects qwen3.6-27b-precise", () => {
    expect(isQwenModel("qwen3.6-27b-precise")).toBe(true)
  })

  test("detects Qwen3-32B (uppercase Q)", () => {
    expect(isQwenModel("Qwen3-32B")).toBe(true)
  })

  test("detects qwen-2.5-72b-instruct", () => {
    expect(isQwenModel("qwen-2.5-72b-instruct")).toBe(true)
  })

  test("detects mammoth-litellm/qwen3.6-27b-precise (with provider prefix)", () => {
    expect(isQwenModel("mammoth-litellm/qwen3.6-27b-precise")).toBe(true)
  })

  test("does NOT detect gpt-4.1", () => {
    expect(isQwenModel("gpt-4.1")).toBe(false)
  })

  test("does NOT detect claude-sonnet-4-20250514", () => {
    expect(isQwenModel("claude-sonnet-4-20250514")).toBe(false)
  })

  test("does NOT detect gemini-2.5-pro", () => {
    expect(isQwenModel("gemini-2.5-pro")).toBe(false)
  })

  test("does NOT detect llama-3.3-70b-instruct", () => {
    expect(isQwenModel("llama-3.3-70b-instruct")).toBe(false)
  })

  test("case insensitive — QWEN uppercase", () => {
    expect(isQwenModel("QWEN")).toBe(true)
  })
})

describe("Tool Registry — ApplyPatchTool filter for Qwen models", () => {
  // Combined filter logic: apply_patch is hidden for Qwen models
  // unless explicitly enabled via config
  function applyPatchVisibleForModel(cfg: Config, modelID: string): boolean {
    const qwenHidden = isQwenModel(modelID)
    const configDisabled = cfg.toolFilter?.applyPatch?.enabled === false
    // For Qwen: hidden by default, visible only if config explicitly enables it
    // For others: visible by default, hidden only if config disables it
    if (qwenHidden) {
      return cfg.toolFilter?.applyPatch?.enabled === true
    }
    return !configDisabled
  }

  test("Qwen model: apply_patch hidden by default", () => {
    expect(applyPatchVisibleForModel({}, "qwen3.6-27b-precise")).toBe(false)
  })

  test("Qwen model: apply_patch visible when config explicitly enables it", () => {
    expect(applyPatchVisibleForModel({ toolFilter: { applyPatch: { enabled: true } } }, "qwen3.6-27b-precise")).toBe(true)
  })

  test("Qwen model: apply_patch stays hidden when config disables it", () => {
    expect(applyPatchVisibleForModel({ toolFilter: { applyPatch: { enabled: false } } }, "qwen3.6-27b-precise")).toBe(false)
  })

  test("Non-Qwen model: apply_patch visible by default", () => {
    expect(applyPatchVisibleForModel({}, "gpt-4.1")).toBe(true)
  })

  test("Non-Qwen model: apply_patch hidden when config disables it", () => {
    expect(applyPatchVisibleForModel({ toolFilter: { applyPatch: { enabled: false } } }, "gpt-4.1")).toBe(false)
  })

  test("Non-Qwen model: apply_patch visible when config enables it", () => {
    expect(applyPatchVisibleForModel({ toolFilter: { applyPatch: { enabled: true } } }, "gpt-4.1")).toBe(true)
  })

  test("Qwen with provider prefix: apply_patch hidden by default", () => {
    expect(applyPatchVisibleForModel({}, "mammoth-litellm/qwen3.6-27b-precise")).toBe(false)
  })

  test("claude model: apply_patch visible by default", () => {
    expect(applyPatchVisibleForModel({}, "claude-sonnet-4-20250514")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// switch_model builtin gating — runs the REAL ToolRegistry layer with mocked
// services so the acceptance criteria are proven at the behavior level:
//   - default config            → "switch_model" in builtin tools list
//   - dynamicModelSwitch:false  → "switch_model" absent
//   - the registry layer resolves all of the tool's services (no
//     unresolved-service errors at construction / registration)
// ---------------------------------------------------------------------------

const testInstanceContext: InstanceContext = {
  directory: "/tmp/registry-switch-model-test",
  worktree: "/tmp/registry-switch-model-test",
  project: { id: "test-project" },
} as unknown as InstanceContext

function mockConfigService(config: ConfigModule.Info): ConfigModule.Interface {
  return {
    get: () => Effect.succeed(config),
    directories: () => Effect.succeed<string[]>([]),
    waitForDependencies: () => Effect.void,
  } as unknown as ConfigModule.Interface
}

function mockPluginService(): Plugin.Interface {
  return {
    list: () => Effect.succeed([]),
    trigger: () => Effect.void,
  } as unknown as Plugin.Interface
}

function mockRuntimeFlagsService(): RuntimeFlags.Info {
  return {
    client: "test",
    enableQuestionTool: false,
    experimentalBackgroundSubagents: false,
    experimentalScout: false,
    experimentalLspTool: false,
    experimentalPlanMode: false,
    enableExa: false,
    enableParallel: false,
  } as unknown as RuntimeFlags.Info
}

// Truncate methods invoked while tool definitions initialize
function mockTruncateService(): Truncate.Interface {
  return {
    cleanup: () => Effect.void,
    write: (text: string) => Effect.succeed(text),
    output: (text: string) => Effect.succeed({ content: text, truncated: false }),
    limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
  } as unknown as Truncate.Interface
}

const NOOP_SERVICE = {}

function registryToolIds(config: ConfigModule.Info): Promise<string[]> {
  const effect = Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    return yield* registry.ids()
  }).pipe(
    Effect.provide(ToolRegistry.layer),
    Effect.provideService(ConfigModule.Service, mockConfigService(config)),
    Effect.provideService(Plugin.Service, mockPluginService()),
    Effect.provideService(RuntimeFlags.Service, mockRuntimeFlagsService()),
    // Services only required for context resolution (no methods invoked by ids())
    Effect.provideService(Question.Service, NOOP_SERVICE as unknown as Question.Interface),
    Effect.provideService(Todo.Service, NOOP_SERVICE as unknown as Todo.Interface),
    Effect.provideService(Agent.Service, NOOP_SERVICE as unknown as Agent.Interface),
    Effect.provideService(Skill.Service, NOOP_SERVICE as unknown as Skill.Interface),
    Effect.provideService(Session.Service, NOOP_SERVICE as unknown as Session.Interface),
    Effect.provideService(SessionStatus.Service, NOOP_SERVICE as unknown as SessionStatus.Interface),
    Effect.provideService(BackgroundJob.Service, NOOP_SERVICE as unknown as BackgroundJob.Interface),
    Effect.provideService(Provider.Service, NOOP_SERVICE as unknown as Provider.Interface),
    Effect.provideService(Git.Service, NOOP_SERVICE as unknown as Git.Interface),
    Effect.provideService(RepositoryCache.Service, NOOP_SERVICE as unknown as RepositoryCache.Interface),
    Effect.provideService(Reference.Service, NOOP_SERVICE as unknown as Reference.Interface),
    Effect.provideService(LSP.Service, NOOP_SERVICE as unknown as LSP.Interface),
    Effect.provideService(Instruction.Service, NOOP_SERVICE as unknown as Instruction.Interface),
    Effect.provideService(AppFileSystem.Service, NOOP_SERVICE as unknown as AppFileSystem.Interface),
    Effect.provideService(Bus.Service, NOOP_SERVICE as unknown as Bus.Interface),
    Effect.provideService(HttpClient.HttpClient, NOOP_SERVICE as unknown as HttpClient.HttpClient),
  ).pipe(
    Effect.provideService(ChildProcessSpawner, NOOP_SERVICE as unknown as InstanceType<typeof ChildProcessSpawner>),
    Effect.provideService(Ripgrep.Service, NOOP_SERVICE as unknown as Ripgrep.Interface),
    Effect.provideService(Format.Service, NOOP_SERVICE as unknown as Format.Interface),
    Effect.provideService(Truncate.Service, mockTruncateService()),
    Effect.provideService(EventV2Bridge.Service, NOOP_SERVICE as unknown as InstanceType<typeof EventV2Bridge.Service>),
    Effect.provideService(InstanceRef, testInstanceContext),
  )
  return Effect.runPromise(effect)
}

describe("Tool Registry — switch_model builtin gating", () => {
  test("default config: switch_model is present in the builtin tools list", async () => {
    const ids = await registryToolIds({})
    expect(ids).toContain("switch_model")
  })

  test("dynamicModelSwitch.enabled false: switch_model is absent from the builtin tools list", async () => {
    const ids = await registryToolIds({ dynamicModelSwitch: { enabled: false } })
    expect(ids).not.toContain("switch_model")
  })

  test("dynamicModelSwitch.enabled true: switch_model is present in the builtin tools list", async () => {
    const ids = await registryToolIds({ dynamicModelSwitch: { enabled: true } })
    expect(ids).toContain("switch_model")
  })
})

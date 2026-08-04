import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import path from "path"
import { pathToFileURL } from "url"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { Skill } from "../../src/skill"
import { LLM } from "../../src/session/llm"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(FetchHttpClient.layer),
)
const LLMTest = Layer.succeed(LLM.Service, LLM.Service.of({
  stream: () => Stream.empty,
}))

const it = testEffect(
  Layer.mergeAll(
    Plugin.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(configLayer),
      Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
    ),
    LLMTest,
    CrossSpawnSpawner.defaultLayer,
  ),
)
const toolsHook = "experimental.tools.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const file = path.join(dir, "plugin.ts")
      yield* Effect.all(
        [
          Effect.promise(() => Bun.write(file, source)),
          Effect.promise(() =>
            Bun.write(
              path.join(dir, "opencode.json"),
              JSON.stringify(
                {
                  $schema: "https://opencode.ai/config.json",
                  plugin: [pathToFileURL(file).href],
                },
                null,
                2,
              ),
            ),
          ),
        ],
        { discard: true, concurrency: 2 },
      )
      return yield* self
    }),
  )
}

const triggerToolsTransform = Effect.fn("PluginTriggerTest.triggerToolsTransform")(function* () {
  const plugin = yield* Plugin.Service
  const tools: Record<string, any> = { "existing-tool": { name: "existing-tool" } }
  yield* plugin.trigger(
    toolsHook,
    {
      sessionID: "test-session",
      model: {
        providerID: ProviderID.anthropic,
        modelID: ModelID.make("claude-sonnet-4-6"),
      },
    },
    { tools },
  )
  return tools
})

describe("plugin.trigger experimental.tools.transform", () => {
  it.live("runs hooks that mutate the tools dictionary", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(toolsHook)}: (_input, output) => {`,
        '    output.tools["added-by-plugin"] = { name: "added-by-plugin" }',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        const tools = yield* triggerToolsTransform()
        expect(tools["existing-tool"]).toBeDefined()
        expect(tools["added-by-plugin"]).toBeDefined()
        expect(tools["added-by-plugin"].name).toBe("added-by-plugin")
      }),
    ),
  )

  it.live("returns the modified tools object from trigger", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(toolsHook)}: (_input, output) => {`,
        '    delete output.tools["existing-tool"]',
        '    output.tools["replacement"] = { name: "replacement" }',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        const tools = yield* triggerToolsTransform()
        expect(tools["existing-tool"]).toBeUndefined()
        expect(tools["replacement"]).toBeDefined()
      }),
    ),
  )
})

describe("plugin.getDynamicSkills integration", () => {
  const skillLayer = Skill.defaultLayer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(configLayer),
    Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
  )

  const itIntegration = testEffect(
    Layer.mergeAll(
      skillLayer,
      LLMTest,
      CrossSpawnSpawner.defaultLayer,
    ),
  )

  function withSkillInstance<A, E, R>(self: Effect.Effect<A, E, R>) {
    return provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "opencode.json")
        yield* Effect.promise(() =>
          Bun.write(
            file,
            JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
          ),
        )
        return yield* self
      }),
    )
  }

  itIntegration.live("getDynamicSkills returns dynamic skills registered via Skill.Service", () =>
    withSkillInstance(
      Effect.gen(function* () {
        const skillSrv = yield* Skill.Service

        // Register a dynamic skill
        const registerResult = yield* skillSrv.registerDynamic([
          {
            name: "test-dynamic-skill",
            description: "A dynamically registered test skill",
            location: "file:///tmp/test/.agents/skills/test-dynamic-skill/SKILL.md",
            content: "---\nname: test-dynamic-skill\ndescription: A dynamically registered test skill\n---\nTest content",
          },
        ])
        expect(registerResult.added).toBe(1)
        expect(registerResult.skipped).toBe(0)

        // allIncludingDynamic should return the dynamic skill
        const allIncludingDynamic = yield* skillSrv.allIncludingDynamic()
        const dynamicSkill = allIncludingDynamic.find((s) => s.name === "test-dynamic-skill")
        expect(dynamicSkill).toBeDefined()
        expect(dynamicSkill?.description).toBe("A dynamically registered test skill")

        // Verify the skill is truly dynamic (not in startup skills)
        const startupSkills = yield* skillSrv.all()
        const inStartup = startupSkills.some((s) => s.name === "test-dynamic-skill")
        expect(inStartup).toBe(false)

        return { registered: registerResult.added, foundInAllIncludingDynamic: !!dynamicSkill, foundInStartup: inStartup }
      }),
    ),
  )

  itIntegration.live("allIncludingDynamic includes both startup and dynamic skills", () =>
    withSkillInstance(
      Effect.gen(function* () {
        const skillSrv = yield* Skill.Service

        // Register multiple dynamic skills
        yield* skillSrv.registerDynamic([
          {
            name: "test-dynamic-1",
            description: "First dynamic skill",
            location: "file:///tmp/test/.agents/skills/test-dynamic-1/SKILL.md",
            content: "---\nname: test-dynamic-1\n---\n",
          },
          {
            name: "test-dynamic-2",
            description: "Second dynamic skill",
            location: "file:///tmp/test/.agents/skills/test-dynamic-2/SKILL.md",
            content: "---\nname: test-dynamic-2\n---\n",
          },
        ])

        const allIncludingDynamic = yield* skillSrv.allIncludingDynamic()
        const startupSkills = yield* skillSrv.all()

        const hasDynamic1 = allIncludingDynamic.some((s) => s.name === "test-dynamic-1")
        const hasDynamic2 = allIncludingDynamic.some((s) => s.name === "test-dynamic-2")
        const hasStartup = allIncludingDynamic.length > startupSkills.length

        expect(hasDynamic1).toBe(true)
        expect(hasDynamic2).toBe(true)
        expect(hasStartup).toBe(true)

        return { hasDynamic1, hasDynamic2, hasStartup, totalIncludingDynamic: allIncludingDynamic.length, totalStartup: startupSkills.length }
      }),
    ),
  )
})

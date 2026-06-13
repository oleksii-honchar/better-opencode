import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
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
const it = testEffect(
  Layer.mergeAll(
    Plugin.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(configLayer),
      Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
    ),
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

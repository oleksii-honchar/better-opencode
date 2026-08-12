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
const it = testEffect(
  Layer.mergeAll(
    Plugin.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(configLayer),
      Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
    ),
    Layer.succeed(LLM.Service, LLM.Service.of({ stream: () => Stream.empty })),
    CrossSpawnSpawner.defaultLayer,
  ),
)

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const file = path.join(dir, "plugin.ts")
      yield* Effect.all([
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() => Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(file).href] }))),
      ], { discard: true, concurrency: 2 })
      return yield* self
    }),
  )
}

type HostTool = {
  name?: string
  server?: string
  execute?: (args: unknown) => unknown | Promise<unknown>
}

describe("host catalog regression", () => {
  it.live("keeps concurrent transform outputs correlated with their originating sessions", () =>
    withProject(
      [
        "export default async () => ({",
        '  "experimental.tools.transform": async (input, output) => {',
        '    const source = Object.values(output.tools).find((tool) => tool.server !== "built-in")',
        '    output.tools = { meta_use: { execute: async () => `${input.sessionID}:${source.name}` } }',
        "  },",
        "})",
      ].join("\n"),
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const transform = (sessionID: string, toolName: string) => {
          const output: { tools: Record<string, HostTool> } = {
            tools: { [toolName]: { name: toolName, server: toolName.startsWith("data_dog") ? "data-dog" : "github" } },
          }
          return plugin.trigger("experimental.tools.transform", { sessionID, model: { providerID: ProviderID.anthropic, modelID: ModelID.make("test") } }, output)
        }
        const [outputA, outputB] = yield* Effect.all([
          transform("ses_datadog", "data_dog_search_logs"),
          transform("ses_github", "github_search_issues"),
        ], { concurrency: 2 })
        expect(outputA.tools.meta_use?.execute).toBeDefined()
        expect(outputB.tools.meta_use?.execute).toBeDefined()
        expect(yield* Effect.promise(() => Promise.resolve(outputA.tools.meta_use!.execute!({})))).toBe("ses_datadog:data_dog_search_logs")
        expect(yield* Effect.promise(() => Promise.resolve(outputB.tools.meta_use!.execute!({})))).toBe("ses_github:github_search_issues")
      }),
    ),
  )
})

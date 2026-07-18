import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import fs from "fs"
import path from "path"
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

// ── Source scan tests ──────────────────────────────────────────────────────────

const indexPath = path.join(__dirname, "../../src/plugin/index.ts")
const source = fs.readFileSync(indexPath, "utf-8")

describe("llm-capture — source-level verification", () => {
  test("_cachedLLM variable declared at module level", () => {
    if (!source.includes("let _cachedLLM: LLM.Interface | undefined")) {
      throw new Error("Expected `let _cachedLLM: LLM.Interface | undefined` not found — module-level variable missing")
    }
  })

  test("error message when LLM service not yet available", () => {
    if (!source.includes("LLM service not yet available")) {
      throw new Error("Expected error message \"LLM service not yet available\" not found in plugin/index.ts")
    }
  })
})

// ── Runtime test: Plugin.trigger with LLM.Service in context ──────────────────

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

function withRuntime<A, E, R>(self: Effect.Effect<A, E, R>) {
  return provideTmpdirInstance((_dir: string) => self)
}

const systemHook = "experimental.chat.system.transform"

describe("llm-capture — runtime behavior", () => {
  it.live("Plugin.trigger succeeds with LLM.Service in context", () =>
    withRuntime(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const out = { system: [] as string[] }
        const output = yield* plugin.trigger(
          systemHook,
          {
            model: {
              providerID: ProviderID.anthropic,
              modelID: ModelID.make("claude-sonnet-4-6"),
            },
          },
          out,
        )
        expect(output).toBeDefined()
        expect(output.system).toEqual([])
      }),
    ),
  )
})

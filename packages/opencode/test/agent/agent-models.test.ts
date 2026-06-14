import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { RuntimeFlags } from "../../src/effect/runtime-flags"

const agentLayer = () =>
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
  )

const it = testEffect(agentLayer())

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

afterEach(async () => {
  await disposeAllInstances()
})

it.instance(
  "agent with models field parses all entries via Provider.parseModel",
  () =>
    Effect.gen(function* () {
      const custom = yield* load((svc) => svc.get("my_multi_agent"))
      expect(custom).toBeDefined()
      expect(custom?.models).toBeDefined()
      expect(custom?.models).toHaveLength(2)
      expect(String(custom?.models![0].providerID)).toBe("mammoth")
      expect(String(custom?.models![0].modelID)).toBe("qwen3.6-40b")
      expect(String(custom?.models![1].providerID)).toBe("deepseek")
      expect(String(custom?.models![1].modelID)).toBe("v4-flash")
    }),
  {
    config: {
      agent: {
        my_multi_agent: {
          description: "Multi-provider agent",
          models: ["mammoth/qwen3.6-40b", "deepseek/v4-flash"],
        },
      },
    },
  },
)

it.instance(
  "agent without models field has no models property",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(build?.models).toBeUndefined()
    }),
  {
    config: {
      agent: {
        build: {
          model: "openai/gpt-4",
        },
      },
    },
  },
)

it.instance(
  "agent with both model and models fields has both set",
  () =>
    Effect.gen(function* () {
      const custom = yield* load((svc) => svc.get("dual_agent"))
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.models).toHaveLength(1)
      expect(String(custom?.models![0].providerID)).toBe("mammoth")
      expect(String(custom?.models![0].modelID)).toBe("qwen3.6-40b")
    }),
  {
    config: {
      agent: {
        dual_agent: {
          model: "openai/gpt-4",
          models: ["mammoth/qwen3.6-40b"],
        },
      },
    },
  },
)

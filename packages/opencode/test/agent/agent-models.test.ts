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

// ─── Variant parsing tests ──────────────────────────────────────────────────────
// Task 3: Info.models entry includes optional variant, state construction
// propagates variant from `:variant` suffix in model strings.

it.instance(
  "model with :variant sets item.variant (variant stripped from model)",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.get("variant_model"))
      expect(agent).toBeDefined()
      // model is stripped of variant — no variant field on item.model
      expect(String(agent?.model?.providerID)).toBe("codex")
      expect(String(agent?.model?.modelID)).toBe("gpt-5.5")
      // variant is promoted to item.variant
      expect(agent?.variant).toBe("medium")
    }),
  {
    config: {
      agent: {
        variant_model: {
          model: "codex/gpt-5.5:medium",
        },
      },
    },
  },
)

it.instance(
  "model :variant overrides config-level variant (inline wins)",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.get("variant_override"))
      expect(agent).toBeDefined()
      expect(String(agent?.model?.providerID)).toBe("codex")
      expect(String(agent?.model?.modelID)).toBe("gpt-5.5")
      // inline "medium" wins over explicit "high"
      expect(agent?.variant).toBe("medium")
    }),
  {
    config: {
      agent: {
        variant_override: {
          model: "codex/gpt-5.5:medium",
          variant: "high",
        },
      },
    },
  },
)

it.instance(
  "models[] with :variant stores variant on each entry",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.get("variant_models"))
      expect(agent).toBeDefined()
      expect(agent?.models).toBeDefined()
      expect(agent?.models).toHaveLength(1)
      const entry = agent?.models![0]
      expect(String(entry.providerID)).toBe("codex")
      expect(String(entry.modelID)).toBe("gpt-5.5")
      expect((entry as { variant?: string }).variant).toBe("medium")
      // per-entry variant must NOT leak to item.variant
      expect(agent?.variant).toBeUndefined()
    }),
  {
    config: {
      agent: {
        variant_models: {
          models: ["codex/gpt-5.5:medium"],
        },
      },
    },
  },
)

it.instance(
  "models[] without :variant has variant undefined on each entry",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.get("no_variant_models"))
      expect(agent).toBeDefined()
      expect(agent?.models).toBeDefined()
      expect(agent?.models).toHaveLength(1)
      const entry = agent?.models![0]
      expect(String(entry.providerID)).toBe("codex")
      expect(String(entry.modelID)).toBe("gpt-5.5")
      expect((entry as { variant?: string }).variant).toBeUndefined()
    }),
  {
    config: {
      agent: {
        no_variant_models: {
          models: ["codex/gpt-5.5"],
        },
      },
    },
  },
)

it.instance(
  "config-level variant applies when neither model nor models is set",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.get("config_variant_only"))
      expect(agent).toBeDefined()
      expect(agent?.model).toBeUndefined()
      expect(agent?.models).toBeUndefined()
      expect(agent?.variant).toBe("high")
    }),
  {
    config: {
      agent: {
        config_variant_only: {
          variant: "high",
        },
      },
    },
  },
)

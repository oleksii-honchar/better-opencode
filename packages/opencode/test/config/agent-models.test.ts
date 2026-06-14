import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Config.defaultLayer, AgentSvc.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.instance(
  "agent models field parsed from config as array of strings",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.use.get()
      expect(cfg.agent?.["researcher"]?.models).toEqual([
        "mammoth/qwen3.6-40b",
        "deepseek/deepseek-v4-flash",
      ])
    }),
  {
    git: true,
    config: {
      agent: {
        researcher: {
          models: ["mammoth/qwen3.6-40b", "deepseek/deepseek-v4-flash"],
        },
      },
    },
  },
)

it.instance(
  "agent without models field still parses (backward compatible)",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.use.get()
      expect(cfg.agent?.["build"]).toBeDefined()
      expect(cfg.agent?.["build"]?.model).toBe("mammoth/qwen3.6-27b")
      expect(cfg.agent?.["build"]?.models).toBeUndefined()
    }),
  {
    git: true,
    config: {
      agent: {
        build: { model: "mammoth/qwen3.6-27b" },
      },
    },
  },
)

it.instance(
  "agent with both model and models fields parses both",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.use.get()
      expect(cfg.agent?.["multi"]?.model).toBe("mammoth/qwen3.6-27b")
      expect(cfg.agent?.["multi"]?.models).toEqual([
        "mammoth/qwen3.6-40b",
        "deepseek/deepseek-v4-flash",
      ])
    }),
  {
    git: true,
    config: {
      agent: {
        multi: {
          model: "mammoth/qwen3.6-27b",
          models: ["mammoth/qwen3.6-40b", "deepseek/deepseek-v4-flash"],
        },
      },
    },
  },
)

it.instance(
  "agent models field not absorbed into options",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.use.get()
      expect(cfg.agent?.["researcher"]?.models).toEqual(["mammoth/qwen3.6-40b"])
      // models should NOT be in options — it's a known key
      expect(cfg.agent?.["researcher"]?.options?.models).toBeUndefined()
    }),
  {
    git: true,
    config: {
      agent: {
        researcher: {
          models: ["mammoth/qwen3.6-40b"],
        },
      },
    },
  },
)

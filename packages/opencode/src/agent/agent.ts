import { Config } from "@/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SCOUT from "./prompt/scout.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { WorkspaceFoldersRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { type DeepMutable } from "@opencode-ai/core/schema"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ),
  models: Schema.optional(
    Schema.Array(
      Schema.Struct({
        modelID: ModelID,
        providerID: ProviderID,
        variant: Schema.optional(Schema.String),
      }),
    ),
  ).annotate({
    description: "Provider-specific model selections parsed from config",
  }),
  smartModels: Schema.optional(
    Schema.Array(
      Schema.Struct({
        modelID: ModelID,
        providerID: ProviderID,
        variant: Schema.optional(Schema.String),
      }),
    ),
  ).annotate({
    description: "Provider-scoped smart models for in-flight switching, parsed from config",
  }),
  startupContract: Schema.optional(
    Schema.Struct({
      scaffold: Schema.optional(Schema.Boolean),
    }),
  ).annotate({
    description: "Startup contract the agent must satisfy before its first reply (e.g. session scaffold)",
  }),
  modelPreset: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
  allowedMcpCategories: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "MCP server categories this agent can access",
  }),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service

    const state = Effect.fn("Agent.state")(function* () {
      const ctx = yield* InstanceRef
      const cfg = yield* config.get()
      const skillDirs = yield* skill.dirs()
      const workspaceFolders = (yield* WorkspaceFoldersRef) ?? ctx?.workspaceFolders
      const whitelistedDirs = [
        Truncate.GLOB,
        path.join(Global.Path.tmp, "*"),
        ...skillDirs.map((dir) => path.join(dir, "*")),
        ...(workspaceFolders ?? []).map((dir: string) => path.join(dir, "*")),
      ]
      const readonlyExternalDirectory = {
        "*": "ask",
        ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
      } satisfies Record<string, "allow" | "ask" | "deny">

      const defaults = Permission.fromConfig({
        "*": "allow",
        doom_loop: "allow",
        external_directory: {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        },
        question: "deny",
        plan_enter: "deny",
        plan_exit: "deny",
        repo_clone: "deny",
        repo_overview: "deny",
        // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
        read: {
          "*": "allow",
          "*.env": "ask",
          "*.env.*": "ask",
          "*.env.example": "allow",
        },
      })

      const user = Permission.fromConfig(cfg.permission ?? {})

      const agents: Record<string, Info> = {
        build: {
          name: "build",
          description: "The default agent. Executes tools based on configured permissions.",
          options: {},
          permission: Permission.merge(
            defaults,
            Permission.fromConfig({
              question: "allow",
              plan_enter: "allow",
            }),
            user,
          ),
          mode: "primary",
          native: true,
        },
        plan: {
          name: "plan",
          description: "Plan mode. Disallows all edit tools.",
          options: {},
          permission: Permission.merge(
            defaults,
            Permission.fromConfig({
              question: "allow",
              plan_exit: "allow",
              external_directory: {
                [path.join(Global.Path.data, "plans", "*")]: "allow",
              },
              edit: {
                "*": "deny",
                [path.join(".opencode", "plans", "*.md")]: "allow",
                [path.relative(ctx?.worktree ?? "/", path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
              },
            }),
            user,
          ),
          mode: "primary",
          native: true,
        },
        general: {
          name: "general",
          description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
          permission: Permission.merge(
            defaults,
            Permission.fromConfig({
              todowrite: "deny",
            }),
            user,
          ),
          options: {},
          mode: "subagent",
          native: true,
        },
        explore: {
          name: "explore",
          permission: Permission.merge(
            defaults,
            Permission.fromConfig({
              "*": "deny",
              grep: "allow",
              glob: "allow",
              list: "allow",
              bash: "allow",
              webfetch: "allow",
              websearch: "allow",
              read: "allow",
              external_directory: readonlyExternalDirectory,
            }),
            user,
          ),
          description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
          prompt: PROMPT_EXPLORE,
          options: {},
          mode: "subagent",
          native: true,
        },
        ...(flags.experimentalScout
          ? {
              scout: {
                name: "scout",
                permission: Permission.merge(
                  defaults,
                  Permission.fromConfig({
                    "*": "deny",
                    grep: "allow",
                    glob: "allow",
                    webfetch: "allow",
                    websearch: "allow",
                    read: "allow",
                    repo_clone: "allow",
                    repo_overview: "allow",
                    external_directory: {
                      ...readonlyExternalDirectory,
                      [path.join(Global.Path.repos, "*")]: "allow",
                    },
                  }),
                  user,
                ),
                description: `Docs and dependency-source specialist. Use this when you need to inspect external documentation, clone dependency repositories into the managed cache, and research library implementation details without modifying the user's workspace.`,
                prompt: PROMPT_SCOUT,
                options: {},
                mode: "subagent" as const,
                native: true,
              },
            }
          : {}),
        compaction: {
          name: "compaction",
          mode: "primary",
          native: true,
          hidden: true,
          prompt: PROMPT_COMPACTION,
          permission: Permission.merge(
            defaults,
            Permission.fromConfig({
              "*": "deny",
            }),
            user,
          ),
          options: {},
        },
        title: {
          name: "title",
          mode: "primary",
          options: {},
          native: true,
          hidden: true,
          temperature: 0.5,
          permission: Permission.merge(
            defaults,
            Permission.fromConfig({
              "*": "deny",
            }),
            user,
          ),
          prompt: PROMPT_TITLE,
        },
        summary: {
          name: "summary",
          mode: "primary",
          options: {},
          native: true,
          hidden: true,
          permission: Permission.merge(
            defaults,
            Permission.fromConfig({
              "*": "deny",
            }),
            user,
          ),
          prompt: PROMPT_SUMMARY,
        },
      }

      for (const [key, value] of Object.entries(cfg.agent ?? {})) {
        if (value.disable) {
          delete agents[key]
          continue
        }
        let item = agents[key]
        if (!item)
          item = agents[key] = {
            name: key,
            mode: "all",
            permission: Permission.merge(defaults, user),
            options: {},
            native: false,
          }
        if (value.model) {
          const parsed = Provider.parseModel(value.model)
          item.model = { providerID: parsed.providerID, modelID: parsed.modelID }
          // Inline variant takes precedence over explicit config variant
          item.variant = parsed.variant ?? value.variant ?? item.variant
        }
        if (value.models) {
          item.models = value.models.map((m) => {
            const parsed = Provider.parseModel(m)
            return {
              providerID: parsed.providerID,
              modelID: parsed.modelID,
              variant: parsed.variant, // preserved for resolveAgentModel
            }
          })
          // Per-entry variant stays on the entry — NOT copied to item.variant.
          // resolveAgentModel applies it when that entry is selected.
          // If no model was set, apply config-level variant:
          if (!value.model) {
            item.variant = value.variant ?? item.variant
          }
        }
        if (value.smartModels) {
          item.smartModels = value.smartModels.map((m) => {
            const parsed = Provider.parseModel(m)
            return { providerID: parsed.providerID, modelID: parsed.modelID, variant: parsed.variant }
          })
        }
        // If neither model nor models was set, apply config-level variant:
        if (!value.model && !value.models) {
          item.variant = value.variant ?? item.variant
        }
        item.modelPreset = value.modelPreset ?? item.modelPreset
        item.prompt = value.prompt ?? item.prompt
        item.description = value.description ?? item.description
        item.temperature = value.temperature ?? item.temperature
        item.topP = value.top_p ?? item.topP
        item.mode = value.mode ?? item.mode
        item.color = value.color ?? item.color
        item.hidden = value.hidden ?? item.hidden
        item.name = value.name ?? item.name
        item.steps = value.steps ?? item.steps
        item.allowedMcpCategories = value.allowedMcpCategories
        item.startupContract = value.startupContract ?? item.startupContract
        item.options = mergeDeep(item.options, value.options ?? {})
        item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
      }

      // Ensure Truncate.GLOB is allowed unless explicitly configured
      for (const name in agents) {
        const agent = agents[name]
        const explicit = agent.permission.some((r) => {
          if (r.permission !== "external_directory") return false
          if (r.action !== "deny") return false
          return r.pattern === Truncate.GLOB
        })
        if (explicit) continue

        agents[name].permission = Permission.merge(
          agents[name].permission,
          Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
        )
      }

      const get = Effect.fnUntraced(function* (agent: string) {
        return agents[agent]
      })

      const list = Effect.fnUntraced(function* () {
        const cfg = yield* config.get()
        return pipe(
          agents,
          values(),
          sortBy(
            [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
            [(x) => x.name, "asc"],
          ),
        )
      })

      const defaultInfo = Effect.fnUntraced(function* () {
        const c = yield* config.get()
        if (c.default_agent) {
          const agent = agents[c.default_agent]
          if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
          if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
          if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
          return agent
        }
        const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
        if (!visible) throw new Error("no primary visible agent found")
        return visible
      })

      const defaultAgent = Effect.fnUntraced(function* () {
        return (yield* defaultInfo()).name
      })

      return {
        get,
        list,
        defaultInfo,
        defaultAgent,
      } satisfies State
    })

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        const s = yield* state()
        return yield* s.get(agent)
      }),
      list: Effect.fn("Agent.list")(function* () {
        const s = yield* state()
        return yield* s.list()
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        const s = yield* state()
        return yield* s.defaultInfo()
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        const s = yield* state()
        return yield* s.defaultAgent()
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* (yield* state()).list()

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

/**
 * Resolves the effective model for an agent:
 * 1. `models` list — two-stage matching against the parent:
 *    a. exact match on (providerID, modelID) mirroring the parent; inherits the
 *       parent's effective variant when present, otherwise keeps the entry's variant
 *    b. provider-only match — the first entry sharing the parent's providerID (legacy)
 * 2. Explicit `model` — return explicit model
 * 3. `modelPreset` — compute suffixed model ID from parent model
 * 4. Falls back to parent model
 */
export function resolveAgentModel(
  agentModels: Info["models"],
  agentModel: Info["model"],
  agentModelPreset: Info["modelPreset"],
  parentModel: { providerID: ProviderID; modelID: ModelID; variant?: string },
): { modelID: ModelID; providerID: ProviderID; variant?: string } {
  // Check models list: 1) exact model match (mirror parent), 2) provider-only match (legacy)
  if (agentModels) {
    const exactMatch = agentModels.find(
      (model) =>
        model.providerID === parentModel.providerID &&
        model.modelID === parentModel.modelID,
    )
    if (exactMatch) {
      return parentModel.variant
        ? { ...exactMatch, variant: parentModel.variant }
        : exactMatch
    }
    const match = agentModels.find((model) => model.providerID === parentModel.providerID)
    if (match) return match
  }
  // Existing resolution chain (unchanged)
  if (agentModel) return agentModel
  if (agentModelPreset) {
    return {
      modelID: ModelID.make(`${parentModel.modelID}-${agentModelPreset}`),
      providerID: parentModel.providerID,
    }
  }
  return parentModel
}

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export * as Agent from "./agent"

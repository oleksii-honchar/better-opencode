import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (
    model: Provider.Model,
    sessionID?: string,
    parentSessionID?: string,
    workspaceFolders?: string[],
    agent?: Agent.Info,
    modelSwitchEnabled?: boolean,
    originalModel?: { providerID: string; modelID: string },
  ) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") { }
const log = Log.create({ service: "system-prompt" })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (
        model: Provider.Model,
        sessionID?: string,
        parentSessionID?: string,
        workspaceFolders?: string[],
        agent?: Agent.Info,
        modelSwitchEnabled?: boolean,
        originalModel?: { providerID: string; modelID: string },
      ) {
        log.info(`workspaceFolders=${JSON.stringify(workspaceFolders)}`, { sessionID })
        const ctx = yield* InstanceState.context
        const env = [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            ...(workspaceFolders && workspaceFolders.length > 0 ? [`  ${  workspaceFolders.length === 1 ? `VS Code workspace folder:` : `VS Code workspace folders:`} ${workspaceFolders.join(", ")}`] : []),
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            ...(sessionID ? [`  Session ID: ${sessionID}`] : []),
            ...(parentSessionID ? [`  Parent Session ID: ${parentSessionID}`] : []),
            `</env>`,
          ].join("\n"),
        ]
const smartModels = agent?.smartModels?.filter((m) => m.providerID === model.providerID) ?? []
        if (smartModels.length > 0 && (modelSwitchEnabled ?? true)) {
          env.push(
            `SMART_MODELS: ${smartModels.map((m) => `${m.providerID}/${m.modelID}`).join(", ")}`,
            "For especially complex tasks — intricate architecture decisions, difficult debugging, or critical implementation choices — you may call the switch_model tool to use a more capable model. The switch applies to the current turn only unless you pass persist: true to switch_model,and a persisted switch stays until the user re-pins a model in the UI. For routine work, keep using your current model.",
          )
        }
        // The original model is exposed regardless of whether the current provider
        // has smart models — switch-back is independent of the smart candidate set.
        if (originalModel && (modelSwitchEnabled ?? true)) {
          env.push(
            `ORIGINAL_MODEL: ${originalModel.providerID}/${originalModel.modelID}`,
            "This is the model this session was running on before any switch_model call. Prefer escalating to a smart model only for the complex round; after it completes, switch back to this original model for routine work. You may switch back to it at any time (even if it is not in SMART_MODELS) by calling switch_model with that model ID.",
          )
        }
        return env
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"

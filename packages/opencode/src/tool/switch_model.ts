import * as Tool from "./tool"
import DESCRIPTION from "./switch_model.txt"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageV2 } from "../session/message-v2"
import { SessionID, MessageID } from "../session/schema"
import { ProviderID, ModelID } from "../provider/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionEvent } from "@opencode-ai/core/session-event"
import { DateTime, Effect, Schema } from "effect"

const id = "switch_model"

const Parameters = Schema.Struct({
  model: Schema.String.annotate({
    description: "Target smart model for the current provider, e.g. 'p1/smart'",
  }),
})

export const SwitchModelTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service

    const execute = Effect.fn("SwitchModelTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context
    ) {
      // Parse the model string
      const { providerID, modelID } = Provider.parseModel(params.model)

      // Get the current provider from the last user message
      const msgs = ctx.messages
      const { user: lastUser } = MessageV2.latest(msgs as MessageV2.WithParts[])

      if (!lastUser?.model?.providerID) {
        return yield* Effect.fail(
          new Error("Cannot determine current provider: no user message found")
        )
      }

      const currentProvider = lastUser.model.providerID

      // Get the agent's smart models
      const agent = yield* agents.get(ctx.agent)
      const smartModels = agent.smartModels ?? []

      // Filter to models for the current provider
      const candidates = smartModels.filter((m) => m.providerID === currentProvider)

      // Check if any smart models are configured for this provider
      if (candidates.length === 0) {
        return yield* Effect.fail(
          new Error(`no smart model configured for provider ${currentProvider}`)
        )
      }

      // Validate the target is in the provider-scoped candidate set
      const isCandidate = candidates.some(
        (c) => c.providerID === providerID && c.modelID === modelID
      )

      if (!isCandidate) {
        const allowedList = candidates
          .map((c) => `${c.providerID}/${c.modelID}`)
          .join(", ")
        return yield* Effect.fail(
          new Error(
            `Not an available smart model for provider ${providerID}. Allowed: ${allowedList}`
          )
        )
      }

      // Validate the model exists in the catalog. On ModelNotFoundError the
      // typed error's message is empty — convert it to a plain Error whose
      // message carries the suggestions, so the model can self-correct when
      // the tool rejection surfaces.
      yield* provider.getModel(providerID, modelID).pipe(
        Effect.catch((e) => {
          if (Provider.ModelNotFoundError.isInstance(e)) {
            const suggestions =
              e.suggestions?.length ? ` Did you mean: ${e.suggestions.join(", ")}?` : ""
            return Effect.fail(
              new Error(
                `Model ${providerID}/${modelID} not found in provider catalog.${suggestions}`
              )
            )
          }
          return Effect.fail(e)
        })
      )

      // Persist the switch on the last user message
      yield* sessions.updateMessage({
        ...lastUser,
        model: { providerID, modelID },
      })

      // Set the session default model
      yield* sessions.setModel(ctx.sessionID, { providerID, modelID })

      // Publish the ModelSwitched event
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID: ctx.sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        model: {
          id: ModelV2.ID.make(modelID),
          providerID: ProviderV2.ID.make(providerID),
          variant: ModelV2.VariantID.make("default"),
        },
      })

      // Return confirmation
      return {
        title: "Model switched",
        metadata: {},
        output: `Switched to ${providerID}/${modelID}`,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        execute(params, ctx).pipe(Effect.orDie),
    }
  })
)

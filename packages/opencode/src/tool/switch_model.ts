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
  persist: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "persist: model stays for the rest of the session until the user re-pins; default false = remainder of this turn only",
    }),
  ),
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
      // Default persist to false (turn-scoped override)
      const persist = params.persist ?? false

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
      const currentModelID = lastUser.model.modelID

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

      // The original model this session started on.
      // Switching back to it is always allowed — it is not a smart-model candidate
      // by design (users must not be forced to list their weak model as a smart one).
      //
      // P1 (ADR-0106 — capture-before-validation):
      // If `session.modelOriginal` is null and the FIRST user message carries a
      // model, record it via `setModelOriginal` BEFORE the allowed-list check.
      // The first user message is the truthful pre-switch original (its `model`
      // is what the session actually started on) — NOT `lastUser.model`, which
      // may already be the smart model after a prior escalation. Recording the
      // first user message's model avoids the switch-back deadlock where
      // `session.model` was polluted to the smart model and the tool could no
      // longer recover the original.
      //
      // Ordering matters: this write must precede the allowed-list check below
      // (and the provider-catalog check) so a first-call switch-back is not
      // rejected before the original is recorded. We never condition on
      // "differs from target" — that would fail to record the original in the
      // exact first-call=switch-back scenario this exists for.
      const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
      let capturedOriginal:
        | { providerID: ProviderID; modelID: ModelID }
        | undefined
      if (!session.modelOriginal) {
        let firstUser: typeof lastUser | undefined
        for (const msg of msgs as MessageV2.WithParts[]) {
          if (msg.info.role !== "user") continue
          const info = msg.info
          if (!info.model?.providerID || !info.model.modelID) continue
          if (!firstUser || info.id < firstUser.id) firstUser = info
        }
        if (firstUser?.model?.providerID && firstUser.model.modelID) {
          capturedOriginal = {
            providerID: ProviderID.make(firstUser.model.providerID),
            modelID: ModelID.make(firstUser.model.modelID),
          }
          if (sessions.setModelOriginal) {
            yield* sessions.setModelOriginal(ctx.sessionID, capturedOriginal)
          }
        }
      }

      // Recompute `originalModel` from the now-set `session.modelOriginal`
      // (reuse the just-written value when we just wrote it — avoids relying
      // on a DB re-read and keeps the rest of the tool deterministic).
      // The fallback chain (session.model → lastUser.model) only kicks in when
      // `modelOriginal` is unset AND the first user message had no model.
      const originalModel =
        session.modelOriginal ??
        capturedOriginal ??
        (session.model
          ? {
              providerID: session.model.providerID,
              modelID: ModelID.make(session.model.id),
            }
          : lastUser.model
            ? {
                providerID: ProviderID.make(lastUser.model.providerID),
                modelID: ModelID.make(lastUser.model.modelID),
              }
            : undefined)

      const isSwitchBack =
        originalModel !== undefined &&
        originalModel.providerID === providerID &&
        originalModel.modelID === modelID

      // Validate the target is either the original model (switch-back) or in the
      // provider-scoped candidate set
      const isCandidate = candidates.some(
        (c) => c.providerID === providerID && c.modelID === modelID
      )

      if (!isSwitchBack && !isCandidate) {
        const allowedList = [...candidates.map((c) => `${c.providerID}/${c.modelID}`),
          ...(originalModel ? [`${originalModel.providerID}/${originalModel.modelID}`] : [])].join(", ")
        return yield* Effect.fail(
          new Error(
            `Not an available model for provider ${providerID}. Allowed: ${allowedList}`
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

      // Session-scoped override (survives turns) only when persist: true.
      // When persist is false (default), only the current message is updated —
      // future turns continue using the session's default model.
      if (persist) {
        yield* sessions.setModel(ctx.sessionID, { providerID, modelID })
      }

      // Durable override when persisting (survives turns until user re-pin).
      // Switch-back restores the session default: clear any previous override
      // rather than writing a new one.
      if (persist) {
        if (isSwitchBack) {
          yield* sessions.clearModelOverride(ctx.sessionID)
        } else {
          yield* sessions.setModelOverride(ctx.sessionID, { providerID, modelID })
        }
      }

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

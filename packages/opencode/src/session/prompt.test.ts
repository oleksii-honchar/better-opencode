import { describe, expect, test } from "bun:test"
import { ModelID, ProviderID } from "@/provider/schema"
import { resolvePromptModel, resolveOriginalModel } from "./prompt"

// The prompt model-resolution precedence (D2 "override-first", spec A2):
//   sessionModelOverride ?? input.model ?? ag.model ?? currentModel(sessionID)
// — with the scoping guard: the override is consulted ONLY when the agent
// declares a `smartModels` scope AND the override's model belongs to it.
//
// The helper returns undefined when none of the static candidates apply; the
// caller then falls back to the effectful currentModel(sessionID).

const model = (providerID: string, modelID: string) => ({
  providerID: ProviderID.make(providerID),
  modelID: ModelID.make(modelID),
})

describe("resolvePromptModel — override-first precedence (Task 4)", () => {
  test("override wins over input.model when the agent has a smartModels scope containing it", () => {
    const override = model("p1", "smart")
    const resolved = resolvePromptModel({
      override,
      agentSmartModels: [{ providerID: "p1", modelID: "smart" }],
      inputModel: model("p1", "other"),
      agentModel: model("p1", "agent-default"),
    })
    expect(resolved).toEqual(override)
  })

  test("override wins when in scope and neither input.model nor agent.model is set", () => {
    const override = model("p1", "smart")
    const resolved = resolvePromptModel({
      override,
      agentSmartModels: [{ providerID: "p1", modelID: "smart" }],
    })
    expect(resolved).toEqual(override)
  })

  test("override ignored when the agent has no smartModels scope (falls through to old precedence)", () => {
    const resolved = resolvePromptModel({
      override: { providerID: "p1", modelID: "smart" },
      agentSmartModels: undefined,
      inputModel: model("p1", "other"),
      agentModel: model("p1", "agent-default"),
    })
    expect(resolved).toEqual(model("p1", "other"))
  })

  test("override ignored when the override model is outside the smartModels scope", () => {
    const resolved = resolvePromptModel({
      override: { providerID: "p1", modelID: "unrelated" },
      agentSmartModels: [{ providerID: "p1", modelID: "smart" }],
      inputModel: model("p1", "other"),
      agentModel: model("p1", "agent-default"),
    })
    expect(resolved).toEqual(model("p1", "other"))
  })

  test("empty smartModels array counts as no scope — override ignored", () => {
    const resolved = resolvePromptModel({
      override: { providerID: "p1", modelID: "smart" },
      agentSmartModels: [],
      inputModel: model("p1", "other"),
    })
    expect(resolved).toEqual(model("p1", "other"))
  })

  test("regression: without an override, input.model wins over agent.model (unchanged precedence)", () => {
    const resolved = resolvePromptModel({
      override: null,
      agentSmartModels: [{ providerID: "p1", modelID: "smart" }],
      inputModel: model("p1", "input"),
      agentModel: model("p1", "agent-default"),
    })
    expect(resolved).toEqual(model("p1", "input"))
  })

  test("regression: without an override and input.model, agent.model is used (unchanged precedence)", () => {
    const resolved = resolvePromptModel({
      override: null,
      agentSmartModels: undefined,
      inputModel: undefined,
      agentModel: model("p1", "agent-default"),
    })
    expect(resolved).toEqual(model("p1", "agent-default"))
  })

  test("without any static candidate, returns undefined so the caller falls back to currentModel", () => {
    const resolved = resolvePromptModel({
      override: undefined,
      agentSmartModels: undefined,
      inputModel: undefined,
      agentModel: undefined,
    })
    expect(resolved).toBeUndefined()
  })
})

describe("resolveOriginalModel — fallback chain (Task 4)", () => {
  test("B4 env (with SMART_MODELS): session.modelOriginal wins and is used for ORIGINAL_MODEL env", () => {
    const session = {
      modelOriginal: { providerID: ProviderID.make("p1"), modelID: ModelID.make("luna") },
      model: { providerID: ProviderID.make("p1"), id: ModelID.make("terra"), name: "terra" } as any,
    }
    const resolved = resolveOriginalModel(session as any, [])
    expect(resolved).toEqual({ providerID: "p1", modelID: "luna" })
  })

  test("B4 env (without SMART_MODELS): session.modelOriginal still wins (env emission independent of SMART_MODELS)", () => {
    const session = {
      modelOriginal: { providerID: ProviderID.make("p1"), modelID: ModelID.make("luna") },
      model: { providerID: ProviderID.make("p1"), id: ModelID.make("terra"), name: "terra" } as any,
    }
    const resolved = resolveOriginalModel(session as any, [])
    expect(resolved).toEqual({ providerID: "p1", modelID: "luna" })
  })

  test("Fallback #2: modelOriginal=null, first user message model wins over polluted session.model", () => {
    const session = {
      modelOriginal: null,
      model: { providerID: ProviderID.make("p1"), id: ModelID.make("terra"), name: "terra" } as any,
    }
    const msgs = [
      {
        info: {
          id: "msg-1",
          role: "user",
          model: { providerID: ProviderID.make("p1"), modelID: ModelID.make("luna") },
        } as any,
        parts: [],
      },
    ]
    const resolved = resolveOriginalModel(session as any, msgs as any)
    expect(resolved).toEqual({ providerID: "p1", modelID: "luna" })
  })

  test("Fallback #3: modelOriginal=null, no first user message model — falls back to session.model", () => {
    const session = {
      modelOriginal: null,
      model: { providerID: ProviderID.make("p1"), id: ModelID.make("terra"), name: "terra" } as any,
    }
    const msgs = [
      {
        info: { id: "msg-1", role: "user", model: null } as any,
        parts: [],
      },
    ]
    const resolved = resolveOriginalModel(session as any, msgs as any)
    expect(resolved).toEqual({ providerID: "p1", modelID: "terra" })
  })

  test("All fallbacks null: returns undefined", () => {
    const session = {
      modelOriginal: null,
      model: null,
    }
    const msgs = [
      {
        info: { id: "msg-1", role: "user", model: null } as any,
        parts: [],
      },
    ]
    const resolved = resolveOriginalModel(session as any, msgs as any)
    expect(resolved).toBeUndefined()
  })

  test("Non-user messages ignored when finding first user message model", () => {
    const session = {
      modelOriginal: null,
      model: { providerID: ProviderID.make("p1"), id: ModelID.make("terra"), name: "terra" } as any,
    }
    const msgs = [
      {
        info: { id: "msg-1", role: "assistant", model: { providerID: ProviderID.make("p1"), modelID: ModelID.make("luna") } } as any,
        parts: [],
      },
      {
        info: { id: "msg-2", role: "user", model: { providerID: ProviderID.make("p1"), modelID: ModelID.make("fast") } } as any,
        parts: [],
      },
    ]
    const resolved = resolveOriginalModel(session as any, msgs as any)
    expect(resolved).toEqual({ providerID: "p1", modelID: "fast" })
  })
})

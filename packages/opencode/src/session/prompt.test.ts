import { describe, expect, test } from "bun:test"
import { ModelID, ProviderID } from "@/provider/schema"
import { resolvePromptModel } from "./prompt"

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

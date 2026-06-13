import { describe, it, expect } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { ModelID, ProviderID } from "../../src/provider/schema"

describe("resolveAgentModel", () => {
  const parentModel = {
    providerID: ProviderID.make("openai-compatible"),
    modelID: ModelID.make("qwopus3.6-27b"),
  }

  it("uses explicit agent model when set (takes precedence over modelPreset)", () => {
    const explicitModel = {
      providerID: ProviderID.make("openai"),
      modelID: ModelID.make("gpt-4"),
    }
    const result = Agent.resolveAgentModel(explicitModel, "precise", parentModel)
    expect(result).toEqual(explicitModel)
  })

  it("computes suffixed model ID when modelPreset is set", () => {
    const result = Agent.resolveAgentModel(undefined, "precise", parentModel)
    expect(result.providerID).toBe(parentModel.providerID)
    expect(result.modelID).toBe(ModelID.make("qwopus3.6-27b-precise"))
  })

  it("computes suffixed model ID with instruct preset", () => {
    const result = Agent.resolveAgentModel(undefined, "instruct", parentModel)
    expect(result.providerID).toBe(parentModel.providerID)
    expect(result.modelID).toBe(ModelID.make("qwopus3.6-27b-instruct"))
  })

  it("computes suffixed model ID with custom preset string", () => {
    const result = Agent.resolveAgentModel(undefined, "coder-precise", parentModel)
    expect(result.providerID).toBe(parentModel.providerID)
    expect(result.modelID).toBe(ModelID.make("qwopus3.6-27b-coder-precise"))
  })

  it("returns parent model when neither agent model nor modelPreset is set", () => {
    const result = Agent.resolveAgentModel(undefined, undefined, parentModel)
    expect(result).toEqual(parentModel)
  })

  it("inherits provider ID from parent model", () => {
    const result = Agent.resolveAgentModel(undefined, "precise", parentModel)
    expect(result.providerID).toBe(parentModel.providerID)
  })
})

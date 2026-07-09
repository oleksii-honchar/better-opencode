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
    const result = Agent.resolveAgentModel(undefined, explicitModel, "precise", parentModel)
    expect(result).toEqual(explicitModel)
  })

  it("computes suffixed model ID when modelPreset is set", () => {
    const result = Agent.resolveAgentModel(undefined, undefined, "precise", parentModel)
    expect(result.providerID).toBe(parentModel.providerID)
    expect(result.modelID).toBe(ModelID.make("qwopus3.6-27b-precise"))
  })

  it("computes suffixed model ID with instruct preset", () => {
    const result = Agent.resolveAgentModel(undefined, undefined, "instruct", parentModel)
    expect(result.providerID).toBe(parentModel.providerID)
    expect(result.modelID).toBe(ModelID.make("qwopus3.6-27b-instruct"))
  })

  it("computes suffixed model ID with custom preset string", () => {
    const result = Agent.resolveAgentModel(undefined, undefined, "coder-precise", parentModel)
    expect(result.providerID).toBe(parentModel.providerID)
    expect(result.modelID).toBe(ModelID.make("qwopus3.6-27b-coder-precise"))
  })

  it("returns parent model when neither agent model nor modelPreset is set", () => {
    const result = Agent.resolveAgentModel(undefined, undefined, undefined, parentModel)
    expect(result).toEqual(parentModel)
  })

  it("inherits provider ID from parent model", () => {
    const result = Agent.resolveAgentModel(undefined, undefined, "precise", parentModel)
    expect(result.providerID).toBe(parentModel.providerID)
  })

  describe("models resolution", () => {
    it("matches provider in models list and returns that model", () => {
      const agentModels = [
        { providerID: ProviderID.make("mammoth"), modelID: ModelID.make("qwen3.6-40b") },
        { providerID: ProviderID.make("deepseek"), modelID: ModelID.make("v4-flash") },
      ]
      const mammothParent = {
        providerID: ProviderID.make("mammoth"),
        modelID: ModelID.make("default-model"),
      }
      const result = Agent.resolveAgentModel(agentModels, undefined, undefined, mammothParent)
      expect(result.providerID).toBe(ProviderID.make("mammoth"))
      expect(result.modelID).toBe(ModelID.make("qwen3.6-40b"))
    })

    it("falls through to explicit model when no provider match in models list", () => {
      const agentModels = [
        { providerID: ProviderID.make("mammoth"), modelID: ModelID.make("qwen3.6-40b") },
      ]
      const explicitModel = {
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-4"),
      }
      const result = Agent.resolveAgentModel(agentModels, explicitModel, undefined, parentModel)
      expect(result).toEqual(explicitModel)
    })

    it("models takes precedence over explicit model when provider matches", () => {
      const agentModels = [
        { providerID: ProviderID.make("openai-compatible"), modelID: ModelID.make("qwen3.6-40b") },
      ]
      const explicitModel = {
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-4"),
      }
      const result = Agent.resolveAgentModel(agentModels, explicitModel, undefined, parentModel)
      expect(result.providerID).toBe(ProviderID.make("openai-compatible"))
      expect(result.modelID).toBe(ModelID.make("qwen3.6-40b"))
    })

    it("falls through to modelPreset when no provider match in models list", () => {
      const agentModels = [
        { providerID: ProviderID.make("mammoth"), modelID: ModelID.make("qwen3.6-40b") },
      ]
      const result = Agent.resolveAgentModel(agentModels, undefined, "precise", parentModel)
      expect(result.providerID).toBe(parentModel.providerID)
      expect(result.modelID).toBe(ModelID.make("qwopus3.6-27b-precise"))
    })

    it("falls through to parent model when no provider match in models list", () => {
      const agentModels = [
        { providerID: ProviderID.make("mammoth"), modelID: ModelID.make("qwen3.6-40b") },
      ]
      const result = Agent.resolveAgentModel(agentModels, undefined, undefined, parentModel)
      expect(result).toEqual(parentModel)
    })

    it("falls through to existing chain when models list is empty", () => {
      const agentModels: Array<{ providerID: ProviderID; modelID: ModelID }> = []
      const result = Agent.resolveAgentModel(agentModels, undefined, "precise", parentModel)
      expect(result.providerID).toBe(parentModel.providerID)
      expect(result.modelID).toBe(ModelID.make("qwopus3.6-27b-precise"))
    })

    it("falls through to parent model when models list is empty and no model or preset", () => {
      const agentModels: Array<{ providerID: ProviderID; modelID: ModelID }> = []
      const result = Agent.resolveAgentModel(agentModels, undefined, undefined, parentModel)
      expect(result).toEqual(parentModel)
    })

    it("falls through when agentModels is undefined", () => {
      const explicitModel = {
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-4"),
      }
      const result = Agent.resolveAgentModel(undefined, explicitModel, undefined, parentModel)
      expect(result).toEqual(explicitModel)
    })
  })

  describe("variant propagation", () => {
    it("propagates variant from models entry when present", () => {
      const agentModels = [
        {
          providerID: ProviderID.make("mammoth"),
          modelID: ModelID.make("qwen3.6-40b"),
          variant: "medium" as string | undefined,
        },
        { providerID: ProviderID.make("deepseek"), modelID: ModelID.make("v4-flash") },
      ]
      const mammothParent = {
        providerID: ProviderID.make("mammoth"),
        modelID: ModelID.make("default-model"),
      }
      const result = Agent.resolveAgentModel(agentModels, undefined, undefined, mammothParent)
      expect(result.providerID).toBe(ProviderID.make("mammoth"))
      expect(result.modelID).toBe(ModelID.make("qwen3.6-40b"))
      expect(result.variant).toBe("medium")
    })

    it("has undefined variant when models entry has no variant", () => {
      const agentModels = [
        { providerID: ProviderID.make("mammoth"), modelID: ModelID.make("qwen3.6-40b") },
      ]
      const mammothParent = {
        providerID: ProviderID.make("mammoth"),
        modelID: ModelID.make("default-model"),
      }
      const result = Agent.resolveAgentModel(agentModels, undefined, undefined, mammothParent)
      expect(result.variant).toBeUndefined()
    })

    it("has undefined variant when falling back to agentModel (no match in models)", () => {
      const agentModels = [
        { providerID: ProviderID.make("mammoth"), modelID: ModelID.make("qwen3.6-40b") },
      ]
      const explicitModel = {
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-4"),
      }
      const result = Agent.resolveAgentModel(agentModels, explicitModel, undefined, parentModel)
      expect(result).toEqual(explicitModel)
      expect(result.variant).toBeUndefined()
    })

    it("has undefined variant when falling back to modelPreset", () => {
      const result = Agent.resolveAgentModel(undefined, undefined, "precise", parentModel)
      expect(result.variant).toBeUndefined()
    })

    it("has undefined variant when falling back to parentModel", () => {
      const result = Agent.resolveAgentModel(undefined, undefined, undefined, parentModel)
      expect(result.variant).toBeUndefined()
    })
  })
})

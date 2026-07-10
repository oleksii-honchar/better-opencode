import { describe, expect, test } from "bun:test"
import { ACP } from "../../src/acp/agent"
import { ModelID, ProviderID } from "../../src/provider/schema"

// Provider models fixture matching the ACP provider config shape
function provider(
  id: string,
  models: Record<string, { id: string; name: string; variants?: Record<string, unknown> }>,
) {
  return { id, models }
}

const providers = [
  provider("codex", {
    "gpt-5.5": {
      id: "gpt-5.5",
      name: "GPT 5.5",
      variants: { medium: {}, high: {} },
    },
  }),
  provider("anthropic", {
    "claude-sonnet-4": {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      variants: { high: {} },
    },
  }),
  provider("openrouter", {
    "gpt-5.5": {
      id: "gpt-5.5",
      name: "GPT 5.5",
    },
  }),
]

describe("parseModelSelection", () => {
  // AC 1: :variant format extracts variant via parseModel
  test(":variant syntax returns variant from parsed.variant when model has variants", () => {
    const result = ACP.parseModelSelection("codex/gpt-5.5:medium", providers)
    expect(result).toEqual({
      model: { providerID: ProviderID.make("codex"), modelID: ModelID.make("gpt-5.5") },
      variant: "medium",
    })
  })

  // AC 2: Legacy /variant format still works
  test("legacy /variant syntax still extracts variant via / fallback", () => {
    const result = ACP.parseModelSelection("anthropic/claude-sonnet-4/high", providers)
    expect(result).toEqual({
      model: { providerID: ProviderID.make("anthropic"), modelID: ModelID.make("claude-sonnet-4") },
      variant: "high",
    })
  })

  // AC 3: No variant in either format returns variant: undefined
  test("no variant returns variant: undefined", () => {
    const result = ACP.parseModelSelection("anthropic/claude-sonnet-4", providers)
    expect(result).toEqual({
      model: { providerID: ProviderID.make("anthropic"), modelID: ModelID.make("claude-sonnet-4") },
      variant: undefined,
    })
  })

  // Backward compat: model without variant on provider that has no variants
  test("backward compatible - model without variants config", () => {
    const result = ACP.parseModelSelection("openrouter/gpt-5.5", providers)
    expect(result).toEqual({
      model: { providerID: ProviderID.make("openrouter"), modelID: ModelID.make("gpt-5.5") },
      variant: undefined,
    })
  })

  // Provider not found returns parsed model with no variant
  test("unknown provider returns model with undefined variant", () => {
    const result = ACP.parseModelSelection("unknown/model", providers)
    expect(result).toEqual({
      model: { providerID: ProviderID.make("unknown"), modelID: ModelID.make("model") },
      variant: undefined,
    })
  })

  // :variant on model that doesn't have that variant should fallback correctly
  test(":variant on model without matching variant entry returns undefined variant", () => {
    // "openrouter/gpt-5.5" exists but has no variants config
    const result = ACP.parseModelSelection("openrouter/gpt-5.5:medium", providers)
    // Falls through: model exists directly, no variant match
    // Without :variant handling it would return the model with undefined variant
    expect(result).toEqual({
      model: { providerID: ProviderID.make("openrouter"), modelID: ModelID.make("gpt-5.5") },
      variant: undefined,
    })
  })
})

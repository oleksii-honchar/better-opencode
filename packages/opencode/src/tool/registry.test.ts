import { describe, test, expect } from "bun:test"
import { Effect, Layer, Scope } from "effect"

// ---------------------------------------------------------------------------
// Mock type matching the config subset used by registry.ts
// ---------------------------------------------------------------------------
type Config = { toolFilter?: { applyPatch?: { enabled?: boolean } } }

// The filtering condition used in registry.ts builtin array:
//   ...(cfg.toolFilter?.applyPatch?.enabled !== false ? [tool.patch] : []),
function applyPatchIncluded(cfg: Config): boolean {
  return cfg.toolFilter?.applyPatch?.enabled !== false
}

// ---------------------------------------------------------------------------
// Qwen model detection helper — mirrors isQwenModel from registry.ts
// ---------------------------------------------------------------------------
function isQwenModel(modelID: string): boolean {
  return /qwen/i.test(modelID)
}

describe("Tool Registry — ApplyPatchTool filtering", () => {
  test("included when config has no toolFilter (default behavior preserved)", () => {
    expect(applyPatchIncluded({})).toBe(true)
  })

  test("included when toolFilter is present but applyPatch is absent", () => {
    expect(applyPatchIncluded({ toolFilter: {} })).toBe(true)
  })

  test("included when applyPatch is present but enabled is absent", () => {
    expect(applyPatchIncluded({ toolFilter: { applyPatch: {} } })).toBe(true)
  })

  test("included when toolFilter.applyPatch.enabled is true", () => {
    expect(applyPatchIncluded({ toolFilter: { applyPatch: { enabled: true } } })).toBe(true)
  })

  test("excluded when toolFilter.applyPatch.enabled is false", () => {
    expect(applyPatchIncluded({ toolFilter: { applyPatch: { enabled: false } } })).toBe(false)
  })

  test("included when toolFilter is null-like (safety check)", () => {
    expect(applyPatchIncluded({ toolFilter: undefined })).toBe(true)
    expect(applyPatchIncluded({ toolFilter: { applyPatch: undefined } })).toBe(true)
  })
})

describe("Qwen Model Detection — isQwenModel", () => {
  test("detects qwen3.6-27b-precise", () => {
    expect(isQwenModel("qwen3.6-27b-precise")).toBe(true)
  })

  test("detects Qwen3-32B (uppercase Q)", () => {
    expect(isQwenModel("Qwen3-32B")).toBe(true)
  })

  test("detects qwen-2.5-72b-instruct", () => {
    expect(isQwenModel("qwen-2.5-72b-instruct")).toBe(true)
  })

  test("detects mammoth-litellm/qwen3.6-27b-precise (with provider prefix)", () => {
    expect(isQwenModel("mammoth-litellm/qwen3.6-27b-precise")).toBe(true)
  })

  test("does NOT detect gpt-4.1", () => {
    expect(isQwenModel("gpt-4.1")).toBe(false)
  })

  test("does NOT detect claude-sonnet-4-20250514", () => {
    expect(isQwenModel("claude-sonnet-4-20250514")).toBe(false)
  })

  test("does NOT detect gemini-2.5-pro", () => {
    expect(isQwenModel("gemini-2.5-pro")).toBe(false)
  })

  test("does NOT detect llama-3.3-70b-instruct", () => {
    expect(isQwenModel("llama-3.3-70b-instruct")).toBe(false)
  })

  test("case insensitive — QWEN uppercase", () => {
    expect(isQwenModel("QWEN")).toBe(true)
  })
})

describe("Tool Registry — ApplyPatchTool filter for Qwen models", () => {
  // Combined filter logic: apply_patch is hidden for Qwen models
  // unless explicitly enabled via config
  function applyPatchVisibleForModel(cfg: Config, modelID: string): boolean {
    const qwenHidden = isQwenModel(modelID)
    const configDisabled = cfg.toolFilter?.applyPatch?.enabled === false
    // For Qwen: hidden by default, visible only if config explicitly enables it
    // For others: visible by default, hidden only if config disables it
    if (qwenHidden) {
      return cfg.toolFilter?.applyPatch?.enabled === true
    }
    return !configDisabled
  }

  test("Qwen model: apply_patch hidden by default", () => {
    expect(applyPatchVisibleForModel({}, "qwen3.6-27b-precise")).toBe(false)
  })

  test("Qwen model: apply_patch visible when config explicitly enables it", () => {
    expect(applyPatchVisibleForModel({ toolFilter: { applyPatch: { enabled: true } } }, "qwen3.6-27b-precise")).toBe(true)
  })

  test("Qwen model: apply_patch stays hidden when config disables it", () => {
    expect(applyPatchVisibleForModel({ toolFilter: { applyPatch: { enabled: false } } }, "qwen3.6-27b-precise")).toBe(false)
  })

  test("Non-Qwen model: apply_patch visible by default", () => {
    expect(applyPatchVisibleForModel({}, "gpt-4.1")).toBe(true)
  })

  test("Non-Qwen model: apply_patch hidden when config disables it", () => {
    expect(applyPatchVisibleForModel({ toolFilter: { applyPatch: { enabled: false } } }, "gpt-4.1")).toBe(false)
  })

  test("Non-Qwen model: apply_patch visible when config enables it", () => {
    expect(applyPatchVisibleForModel({ toolFilter: { applyPatch: { enabled: true } } }, "gpt-4.1")).toBe(true)
  })

  test("Qwen with provider prefix: apply_patch hidden by default", () => {
    expect(applyPatchVisibleForModel({}, "mammoth-litellm/qwen3.6-27b-precise")).toBe(false)
  })

  test("claude model: apply_patch visible by default", () => {
    expect(applyPatchVisibleForModel({}, "claude-sonnet-4-20250514")).toBe(true)
  })
})

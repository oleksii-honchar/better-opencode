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

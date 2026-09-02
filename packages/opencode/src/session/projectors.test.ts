import { describe, expect, test } from "bun:test"
import { toPartialRow } from "./projectors"

// Durability contract for the session override (D2): a cleared override
// (`modelOverride: null`) must flow through the Session.Event.Updated
// projector into the session row (model_override = NULL). `undefined` is
// rejected at the grab() guard — callers must pass null to clear.

describe("projectors.toPartialRow — modelOverride durability", () => {
  test("maps modelOverride: null into the row (clear persists durably)", () => {
    const row = toPartialRow({ modelOverride: null } as any)
    expect(row).toEqual({ model_override: null })
  })

  test("maps modelOverride: {providerID, modelID} into the row (set persists durably)", () => {
    const row = toPartialRow({ modelOverride: { providerID: "p1", modelID: "smart" } } as any)
    expect(row).toEqual({ model_override: { providerID: "p1", modelID: "smart" } })
  })

  test("rejects modelOverride: undefined (pass null to clear a field)", () => {
    expect(() => toPartialRow({ modelOverride: undefined } as any)).toThrow(/pass `null` to clear/)
  })
})
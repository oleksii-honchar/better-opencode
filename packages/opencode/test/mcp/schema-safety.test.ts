/**
 * Tests for buildToolSchema — Schema Safety Net
 *
 * These tests verify the schema construction logic that guards against
 * MCP tools with empty or missing properties definitions. When properties
 * is empty/missing, additionalProperties must be true to prevent LLM
 * hallucinated arguments from being rejected by the schema validator.
 */

import { describe, expect, it } from "bun:test"
import type { JSONSchema7 } from "ai"

// Import the function under test
import { buildToolSchema } from "../../src/mcp/index"

describe("buildToolSchema", () => {
  it("returns schema with additionalProperties: true when properties is empty", () => {
    const input: JSONSchema7 = { properties: {} }
    const result = buildToolSchema(input)

    expect(result.type).toBe("object")
    expect(result.properties).toEqual({})
    expect(result.additionalProperties).toBe(true)
  })

  it("returns schema with additionalProperties: true when properties is missing", () => {
    const input: JSONSchema7 = { type: "object" }
    const result = buildToolSchema(input)

    expect(result.type).toBe("object")
    expect(result.properties).toEqual({})
    expect(result.additionalProperties).toBe(true)
  })

  it("preserves default additionalProperties: false when properties is non-empty", () => {
    const input: JSONSchema7 = { properties: { city: { type: "string" } } }
    const result = buildToolSchema(input)

    expect(result.type).toBe("object")
    expect(result.properties).toEqual({ city: { type: "string" } })
    expect(result.additionalProperties).toBe(false)
  })

  it("preserves explicit additionalProperties: true when properties is non-empty", () => {
    const input: JSONSchema7 = {
      properties: { x: {} },
      additionalProperties: true,
    }
    const result = buildToolSchema(input)

    expect(result.type).toBe("object")
    expect(result.properties).toEqual({ x: {} })
    expect(result.additionalProperties).toBe(true)
  })

  it("preserves explicit additionalProperties: false when properties is non-empty", () => {
    const input: JSONSchema7 = {
      properties: { x: {} },
      additionalProperties: false,
    }
    const result = buildToolSchema(input)

    expect(result.type).toBe("object")
    expect(result.properties).toEqual({ x: {} })
    expect(result.additionalProperties).toBe(false)
  })

  it("always returns type: object regardless of input type", () => {
    const input: JSONSchema7 = {
      type: "string",
      properties: { city: { type: "string" } },
    }
    const result = buildToolSchema(input)

    expect(result.type).toBe("object")
  })

  it("round-trip sanity: non-empty properties with no additionalProperties set gets additionalProperties: false", () => {
    const input: JSONSchema7 = { properties: { name: { type: "string" } } }
    const result = buildToolSchema(input)

    expect(result.type).toBe("object")
    expect(result.additionalProperties).toBe(false)
    expect(result.properties).toEqual({ name: { type: "string" } })
  })
})

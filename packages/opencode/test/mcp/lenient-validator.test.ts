import { describe, expect, it, mock } from "bun:test"
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import { LenientJsonSchemaValidator } from "../../src/mcp/lenient-validator"

describe("LenientJsonSchemaValidator", () => {
  it("valid structuredContent passes through unchanged", () => {
    const schema: JsonSchemaType = {
      $id: "valid-test",
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    }

    const validator = new LenientJsonSchemaValidator()
    const validate = validator.getValidator(schema)
    const result = validate({ name: "test" })

    expect(result.valid).toBe(true)
    expect(result.data).toEqual({ name: "test" })
    expect(result.errorMessage).toBeUndefined()
  })

  it("additionalProperties error suppressed — returns valid with original data", () => {
    const schema: JsonSchemaType = {
      $id: "additional-props-test",
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    }

    const validator = new LenientJsonSchemaValidator()
    const validate = validator.getValidator(schema)
    const result = validate({ name: "test", extra: "unexpected" })

    expect(result.valid).toBe(true)
    expect(result.data).toEqual({ name: "test", extra: "unexpected" })
    expect(result.errorMessage).toBeUndefined()
  })

  it("type mismatch error still fails", () => {
    const schema: JsonSchemaType = {
      $id: "type-mismatch-test",
      type: "object",
      properties: { count: { type: "integer" } },
    }

    const validator = new LenientJsonSchemaValidator()
    const validate = validator.getValidator(schema)
    const result = validate({ count: "not-an-integer" })

    expect(result.valid).toBe(false)
  })

  it("required field error still fails", () => {
    const schema: JsonSchemaType = {
      $id: "required-test",
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    }

    const validator = new LenientJsonSchemaValidator()
    const validate = validator.getValidator(schema)
    const result = validate({})

    expect(result.valid).toBe(false)
  })

  it("warning deduplication — same error logged only once (verify warned.size === 1)", () => {
    const schema: JsonSchemaType = {
      $id: "dedup-test",
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    }

    // Create a mock delegate that returns the same error each time
    // so the dedup key is identical across calls
    const mockDelegate = {
      getValidator: () => {
        return () => ({
          valid: false as const,
          data: undefined,
          errorMessage: "should NOT have additional properties",
        })
      },
    } as unknown as AjvJsonSchemaValidator

    const validator = new LenientJsonSchemaValidator(mockDelegate)
    const validate = validator.getValidator(schema)

    // Call validator twice with the same error — dedup key is identical
    validate({ name: "test", extra: "foo" })
    validate({ name: "test", extra: "bar" })

    // Verify the #warned set has only one entry (dedup working)
    expect(validator.warned.size).toBe(1)
  })
})

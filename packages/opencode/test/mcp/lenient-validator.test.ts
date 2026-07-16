/**
 * Unit tests for LenientJsonSchemaValidator
 *
 * Verifies that the lenient validator tolerates additionalProperties errors
 * (toJsonSchemaCompat false positives) while preserving real validation
 * failures (type mismatches, missing required fields).
 */

import { describe, expect, it } from "bun:test"
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js"

import { LenientJsonSchemaValidator } from "../../src/mcp/lenient-validator"

describe("LenientJsonSchemaValidator", () => {
  it("valid structuredContent passes through", () => {
    const schema: JsonSchemaType = {
      $id: "valid-test",
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    }

    const validator = new LenientJsonSchemaValidator().getValidator(schema)
    const result = validator({ name: "Alice" })

    expect(result.valid).toBe(true)
    expect(result.data).toEqual({ name: "Alice" })
    expect(result.errorMessage).toBeUndefined()
  })

  it("additionalProperties error is suppressed and returns valid", () => {
    const schema: JsonSchemaType = {
      $id: "ap-test",
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    }

    const validator = new LenientJsonSchemaValidator().getValidator(schema)
    const result = validator({ name: "Alice", extraField: "not in schema" })

    expect(result.valid).toBe(true)
    expect(result.data).toEqual({ name: "Alice", extraField: "not in schema" })
    expect(result.errorMessage).toBeUndefined()
  })

  it("type mismatch error still fails", () => {
    const schema: JsonSchemaType = {
      $id: "type-test",
      type: "object",
      properties: { count: { type: "number" } },
      additionalProperties: false,
    }

    const validator = new LenientJsonSchemaValidator().getValidator(schema)
    const result = validator({ count: "not a number" })

    expect(result.valid).toBe(false)
    expect(result.errorMessage).toBeDefined()
  })

  it("required field error still fails", () => {
    const schema: JsonSchemaType = {
      $id: "required-test",
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    }

    const validator = new LenientJsonSchemaValidator().getValidator(schema)
    const result = validator({})

    expect(result.valid).toBe(false)
    expect(result.errorMessage).toBeDefined()
  })

  it("warning deduplication — same error logged only once", () => {
    const schema: JsonSchemaType = {
      $id: "dedup-test",
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    }

    const lenient = new LenientJsonSchemaValidator()
    const validator = lenient.getValidator(schema)

    validator({ name: "Alice", extraField: "not in schema" })
    validator({ name: "Alice", extraField: "not in schema" })

    expect((lenient as any).warned.size).toBe(1)
  })
})

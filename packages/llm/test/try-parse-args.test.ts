import { describe, expect, it } from "bun:test"
import { tryParseArgs } from "../src/protocols/shared"

describe("tryParseArgs", () => {
  it("passes through valid JSON", () => {
    const result = tryParseArgs('{"a":1}')
    expect(result).toBeDefined()
    expect(result!.parsed).toEqual({ a: 1 })
    expect(result!.extracted).toBe('{"a":1}')
  })

  it("extracts first valid object from concatenated objects", () => {
    const result = tryParseArgs('{"a":1}{"a":1,"b":2}')
    expect(result).toBeDefined()
    expect(result!.parsed).toEqual({ a: 1 })
    expect(result!.extracted).toBe('{"a":1}')
  })

  it("handles the exact Datadog hallucination pattern", () => {
    // The first brace-balanced candidate is the whole concatenated string
    // (no `}` separates the two objects). JSON.parse fails, so the algorithm
    // moves on and finds the second (complete) object.
    const result = tryParseArgs('{"query":"test"{"query":"test","from":"now"}}')
    expect(result).toBeDefined()
    expect(result!.parsed).toEqual({ query: "test", from: "now" })
    expect(result!.extracted).toBe('{"query":"test","from":"now"}')
  })

  it("handles strings containing braces", () => {
    const result = tryParseArgs('{"find":"{x}"}')
    expect(result).toBeDefined()
    expect(result!.parsed).toEqual({ find: "{x}" })
    expect(result!.extracted).toBe('{"find":"{x}"}')
  })

  it("handles nested braces", () => {
    const result = tryParseArgs('{"outer":{"inner":1}}')
    expect(result).toBeDefined()
    expect(result!.parsed).toEqual({ outer: { inner: 1 } })
    expect(result!.extracted).toBe('{"outer":{"inner":1}}')
  })

  it("returns undefined for garbage input", () => {
    const result = tryParseArgs("not-json-at-all!!!")
    expect(result).toBeUndefined()
  })

  it("returns undefined for empty string", () => {
    const result = tryParseArgs("")
    expect(result).toBeUndefined()
  })

  it("handles escaped quotes in strings", () => {
    const result = tryParseArgs('{"msg":"hello \\"world\\""}')
    expect(result).toBeDefined()
    expect(result!.parsed).toEqual({ msg: 'hello "world"' })
    expect(result!.extracted).toBe('{"msg":"hello \\"world\\""}')
  })

  it("extracts first valid object when brace-in-value precedes another object", () => {
    // `{"outer":"{x}"}` is valid JSON (the `{` inside string `"{x}"` is
    // handled by inner string-awareness). The algorithm returns this first
    // valid object, not the concatenated second one.
    const result = tryParseArgs('{"outer":"{x}"}{"a":1}')
    expect(result).toBeDefined()
    expect(result!.parsed).toEqual({ outer: "{x}" })
    expect(result!.extracted).toBe('{"outer":"{x}"}')
  })

  it("extracts the first valid object from triple concatenated input", () => {
    const result = tryParseArgs('{}{"a":1}{"b":2}')
    expect(result).toBeDefined()
    expect(result!.parsed).toEqual({})
    expect(result!.extracted).toBe("{}")
  })
})

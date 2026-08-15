import { describe, expect, it } from "bun:test"
import { APICallError } from "ai"
import { ResponseStreamError } from "./error"

describe("ResponseStreamError", () => {
  it("extends APICallError", () => {
    const err = new ResponseStreamError("test message")
    expect(err).toBeInstanceOf(APICallError)
  })

  it("sets the correct error name", () => {
    const err = new ResponseStreamError("test message")
    expect(err.name).toBe("ResponseStreamError")
  })

  it("sets the correct error code in data.type", () => {
    const err = new ResponseStreamError("test message")
    expect(err.data).toEqual({ type: "response-stream-error" })
  })

  it("preserves the message", () => {
    const err = new ResponseStreamError("stream truncated")
    expect(err.message).toBe("stream truncated")
  })
})

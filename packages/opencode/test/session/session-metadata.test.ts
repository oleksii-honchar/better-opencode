import { describe, expect, test } from "bun:test"
import { listAll, get, set, remove } from "../../src/session/session-state"

describe("Session Metadata Service", () => {
  test("functions should have correct signatures", () => {
    expect(typeof set).toBe("function")
    expect(typeof get).toBe("function")
    expect(typeof listAll).toBe("function")
    expect(typeof remove).toBe("function")
  })
})
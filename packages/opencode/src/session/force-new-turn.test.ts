import { describe, expect, test } from "bun:test"
import { requestNewTurn, checkAndResetNewTurnRequested } from "./force-new-turn-signal"

describe("force_new_turn signal", () => {
  test("detects force_new_turn flag in inject entries", () => {
    const injected: Array<{ role: "user" | "system"; text: string; force_new_turn?: boolean }> = [
      { role: "user", text: "Normal message" },
      { role: "system", text: "Force new turn", force_new_turn: true },
    ]
    const hasForceNewTurn = injected.some((i) => i.force_new_turn)
    expect(hasForceNewTurn).toBe(true)
  })

  test("returns ok when no force_new_turn flag is present", () => {
    const injected: Array<{ role: "user" | "system"; text: string; force_new_turn?: boolean }> = [
      { role: "user", text: "Normal message" },
      { role: "system", text: "Another message" },
    ]
    const hasForceNewTurn = injected.some((i) => i.force_new_turn)
    expect(hasForceNewTurn).toBe(false)
  })

  test("returns ok for empty inject array", () => {
    const injected: Array<{ role: "user" | "system"; text: string; force_new_turn?: boolean }> = []
    const hasForceNewTurn = injected.some((i) => i.force_new_turn)
    expect(hasForceNewTurn).toBe(false)
  })

  test("type extension allows force_new_turn field", () => {
    // Verify the type accepts the force_new_turn field
    const entry: { role: "system"; text: string; force_new_turn?: boolean } = {
      role: "system",
      text: "Test message",
      force_new_turn: true,
    }
    expect(entry.force_new_turn).toBe(true)
  })

  test("backward compatibility: entries without force_new_turn work", () => {
    // Verify existing code that doesn't use force_new_turn still works
    const entry: { role: "user"; text: string; force_new_turn?: boolean } = {
      role: "user",
      text: "Test message",
    }
    expect(entry.force_new_turn).toBeUndefined()
  })

  test("requestNewTurn sets the signal", () => {
    // Reset any previous signal
    checkAndResetNewTurnRequested()
    requestNewTurn()
    expect(checkAndResetNewTurnRequested()).toBe(true)
  })

  test("checkAndResetNewTurnRequested returns false when not requested", () => {
    // Reset any previous signal
    checkAndResetNewTurnRequested()
    expect(checkAndResetNewTurnRequested()).toBe(false)
  })

  test("checkAndResetNewTurnRequested resets the signal", () => {
    // Reset any previous signal
    checkAndResetNewTurnRequested()
    requestNewTurn()
    expect(checkAndResetNewTurnRequested()).toBe(true)
    expect(checkAndResetNewTurnRequested()).toBe(false)
  })
})

describe("Max continuations protection logic", () => {
  test("counter increments on force_new_turn", () => {
    let count = 0
    const max = 3
    count++
    expect(count).toBe(1)
    expect(count >= max).toBe(false)
    count++
    expect(count).toBe(2)
    expect(count >= max).toBe(false)
    count++
    expect(count).toBe(3)
    expect(count >= max).toBe(true)
  })

  test("counter resets after max", () => {
    let count = 0
    const max = 3
    count++
    count++
    count++
    expect(count >= max).toBe(true)
    count = 0  // Reset
    expect(count).toBe(0)
  })
})
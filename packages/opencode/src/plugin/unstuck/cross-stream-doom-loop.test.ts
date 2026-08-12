import { describe, expect, test } from "bun:test"
import { CrossStreamDoomLoopManagerImpl, type CrossStreamDoomLoopManager, type DoomLoopRunState } from "./cross-stream-doom-loop"

function createManager(): CrossStreamDoomLoopManager {
  return new CrossStreamDoomLoopManagerImpl()
}

describe("CrossStreamDoomLoopManager — recordCall", () => {
  test("first call returns false and initializes state", () => {
    const manager = createManager()
    const result = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    expect(result).toBe(false)
  })

  test("same session+tool+fingerprint increments count", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const result = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    expect(result).toBe(false)
  })

  test("different tool resets count to 1", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    // Now switch to a different tool
    const result = manager.recordCall("ses-1", "ReadFile", "fp-def", 3)
    expect(result).toBe(false)
  })

  test("different fingerprint resets count to 1", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    // Same tool, different fingerprint
    const result = manager.recordCall("ses-1", "bash", "fp-def", 3)
    expect(result).toBe(false)
  })

  test("returns true when threshold is reached", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const result = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    expect(result).toBe(true)
  })

  test("returns true only on the threshold call, not before", () => {
    const manager = createManager()
    const r1 = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const r2 = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const r3 = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    expect(r1).toBe(false)
    expect(r2).toBe(false)
    expect(r3).toBe(true)
  })

  test("respects custom threshold", () => {
    const manager = createManager()
    const r1 = manager.recordCall("ses-1", "bash", "fp-abc", 5)
    const r2 = manager.recordCall("ses-1", "bash", "fp-abc", 5)
    const r3 = manager.recordCall("ses-1", "bash", "fp-abc", 5)
    const r4 = manager.recordCall("ses-1", "bash", "fp-abc", 5)
    const r5 = manager.recordCall("ses-1", "bash", "fp-abc", 5)
    expect(r1).toBe(false)
    expect(r2).toBe(false)
    expect(r3).toBe(false)
    expect(r4).toBe(false)
    expect(r5).toBe(true)
  })
})

describe("CrossStreamDoomLoopManager — cross-session isolation", () => {
  test("different sessions tracked independently", () => {
    const manager = createManager()

    // Session 1: 2 calls
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)

    // Session 2: 2 calls (same tool/fingerprint, different session)
    manager.recordCall("ses-2", "bash", "fp-abc", 3)
    manager.recordCall("ses-2", "bash", "fp-abc", 3)

    // Session 1: 3rd call — should trigger threshold
    const r1 = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    expect(r1).toBe(true)

    // Session 2: 3rd call — should also trigger threshold
    const r2 = manager.recordCall("ses-2", "bash", "fp-abc", 3)
    expect(r2).toBe(true)
  })

  test("session A below threshold, session B at threshold", () => {
    const manager = createManager()

    // Session A: only 2 calls
    manager.recordCall("ses-a", "bash", "fp-abc", 3)
    manager.recordCall("ses-a", "bash", "fp-abc", 3)

    // Session B: 3 calls — reaches threshold
    manager.recordCall("ses-b", "bash", "fp-abc", 3)
    manager.recordCall("ses-b", "bash", "fp-abc", 3)
    const rB = manager.recordCall("ses-b", "bash", "fp-abc", 3)
    expect(rB).toBe(true)

    // Session A: 3rd call — also reaches threshold
    const rA = manager.recordCall("ses-a", "bash", "fp-abc", 3)
    expect(rA).toBe(true)
  })

  test("no cross-session leakage — session B does not count session A calls", () => {
    const manager = createManager()

    // Session A: 2 calls
    manager.recordCall("ses-a", "bash", "fp-abc", 3)
    manager.recordCall("ses-a", "bash", "fp-abc", 3)

    // Session B: 1 call — should NOT trigger (only 1, threshold is 3)
    const rB = manager.recordCall("ses-b", "bash", "fp-abc", 3)
    expect(rB).toBe(false)
  })
})

describe("CrossStreamDoomLoopManager — resetSession", () => {
  test("clears state for specific session", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)

    manager.resetSession("ses-1")

    // After reset, same call should start fresh
    const r1 = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    expect(r1).toBe(false)
  })

  test("does not affect other sessions", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-2", "bash", "fp-abc", 3)
    manager.recordCall("ses-2", "bash", "fp-abc", 3)

    manager.resetSession("ses-1")

    // ses-2 should still be at count 2, next call triggers threshold
    const r2 = manager.recordCall("ses-2", "bash", "fp-abc", 3)
    expect(r2).toBe(true)
  })

  test("resetting non-existent session is a no-op", () => {
    const manager = createManager()
    manager.resetSession("non-existent")
    // Should not throw
  })
})

describe("CrossStreamDoomLoopManager — clearAll", () => {
  test("clears all session state", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-2", "bash", "fp-abc", 3)

    manager.clearAll()

    const r1 = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const r2 = manager.recordCall("ses-2", "bash", "fp-abc", 3)
    expect(r1).toBe(false)
    expect(r2).toBe(false)
  })

  test("clearAll on empty manager is a no-op", () => {
    const manager = createManager()
    manager.clearAll()
    // Should not throw
  })
})

describe("DoomLoopRunState interface", () => {
  test("state contains required fields", () => {
    // Verify the interface shape by checking that recordCall creates proper state
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)

    // We can't directly inspect internal state (it's a Map), but the behavior
    // proves the state is correctly structured:
    // - toolName is tracked (different tool resets count)
    // - inputFingerprint is tracked (different fp resets count)
    // - count is tracked (increments on same tool+fp)

    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const r = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    expect(r).toBe(true)

    // Different tool resets count
    manager.clearAll()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const r2 = manager.recordCall("ses-1", "ReadFile", "fp-abc", 3)
    expect(r2).toBe(false)

    // Different fingerprint resets count
    manager.clearAll()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const r3 = manager.recordCall("ses-1", "bash", "fp-def", 3)
    expect(r3).toBe(false)
  })
})

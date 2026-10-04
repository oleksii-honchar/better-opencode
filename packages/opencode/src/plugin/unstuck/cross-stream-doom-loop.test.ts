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

  test("different tool starts its own count at 1", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    // Now switch to a different tool
    const result = manager.recordCall("ses-1", "ReadFile", "fp-def", 3)
    expect(result).toBe(false)
  })

  test("different fingerprint starts its own count at 1", () => {
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

describe("CrossStreamDoomLoopManager — per-(session, tool, fingerprint) state (DEC-1)", () => {
  // Incident shape (2026-10-03): getPersonaEntryNode ×623 alternating with
  // recallMemory ×627 — the single-state design reset each tool's count on every
  // interleaving and never reached the threshold.

  test("interleaved A-B-A-B×3 reaches threshold on the third A call", () => {
    const manager = createManager()
    // A = getPersonaEntryNode-like stable call, B = recallMemory-like varying call
    const rA1 = manager.recordCall("ses-1", "getPersonaEntryNode", "fp-entry", 3)
    const rB1 = manager.recordCall("ses-1", "recallMemory", "fp-recall", 3)
    const rA2 = manager.recordCall("ses-1", "getPersonaEntryNode", "fp-entry", 3)
    const rB2 = manager.recordCall("ses-1", "recallMemory", "fp-recall", 3)
    const rA3 = manager.recordCall("ses-1", "getPersonaEntryNode", "fp-entry", 3)

    expect(rA1).toBe(false)
    expect(rB1).toBe(false)
    expect(rA2).toBe(false)
    expect(rB2).toBe(false)
    // Third A call: A's count survived the B interleavings and hits threshold 3.
    expect(rA3).toBe(true)
  })

  test("recordCall counts independently per (session, tool, fingerprint)", () => {
    const manager = createManager()
    // Two fingerprints on the same tool never share a count.
    manager.recordCall("ses-1", "bash", "fp-aaa", 3)
    manager.recordCall("ses-1", "bash", "fp-bbb", 3)
    manager.recordCall("ses-1", "bash", "fp-aaa", 3)
    manager.recordCall("ses-1", "bash", "fp-bbb", 3)
    // fp-aaa is at 2 — next call reaches 3 regardless of fp-bbb's count.
    const rAaa = manager.recordCall("ses-1", "bash", "fp-aaa", 3)
    expect(rAaa).toBe(true)
    // fp-bbb is also at 2 — independent, also reaches 3.
    const rBbb = manager.recordCall("ses-1", "bash", "fp-bbb", 3)
    expect(rBbb).toBe(true)
  })

  test("same tool+fingerprint in different sessions never share a count", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-2", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-2", "bash", "fp-abc", 3)
    // ses-1 at 3 → true; ses-2 at 3 → true; neither counted the other's calls.
    const r1 = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    expect(r1).toBe(true)
  })

  test("resetSession removes every key of that session — counts restart at 1", () => {
    const manager = createManager()
    // Build up two distinct keys for ses-1, one near threshold.
    manager.recordCall("ses-1", "getPersonaEntryNode", "fp-entry", 3)
    manager.recordCall("ses-1", "getPersonaEntryNode", "fp-entry", 3)
    manager.recordCall("ses-1", "recallMemory", "fp-recall", 3)

    manager.resetSession("ses-1")

    // Both keys must have been dropped: each restarts at count 1.
    const rEntry = manager.recordCall("ses-1", "getPersonaEntryNode", "fp-entry", 3)
    const rRecall = manager.recordCall("ses-1", "recallMemory", "fp-recall", 3)
    expect(rEntry).toBe(false)
    expect(rRecall).toBe(false)
    // And they still count independently after the reset.
    manager.recordCall("ses-1", "getPersonaEntryNode", "fp-entry", 3)
    const rEntry3 = manager.recordCall("ses-1", "getPersonaEntryNode", "fp-entry", 3)
    expect(rEntry3).toBe(true)
  })

  test("resetSession leaves other sessions' keys intact", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-2", "bash", "fp-abc", 3)
    manager.recordCall("ses-2", "bash", "fp-abc", 3)

    manager.resetSession("ses-1")

    // ses-2 still at count 2 → next call reaches threshold.
    const r2 = manager.recordCall("ses-2", "bash", "fp-abc", 3)
    expect(r2).toBe(true)
  })

  test("65th distinct key for one session evicts the oldest-inserted key", () => {
    const manager = createManager()
    // Insert 64 distinct keys (the per-session cap).
    for (let i = 0; i < 64; i++) {
      manager.recordCall("ses-1", "bash", `fp-${i}`, 2)
    }
    // Re-record the FIRST key: still present (count 1 → 2) → threshold 2 reached.
    const rFirst = manager.recordCall("ses-1", "bash", "fp-0", 2)
    expect(rFirst).toBe(true)

    // Insert a 65th distinct key → oldest-inserted (fp-0) is evicted.
    manager.recordCall("ses-1", "bash", "fp-64", 2)

    // fp-0 was evicted: its count restarted at 1 → below threshold 2.
    const rEvicted = manager.recordCall("ses-1", "bash", "fp-0", 2)
    expect(rEvicted).toBe(false)
  })

  test("per-session key count never exceeds 64 — newest keys survive eviction", () => {
    const manager = createManager()
    // Insert 70 distinct keys; eviction keeps the 64 most recently inserted.
    for (let i = 0; i < 70; i++) {
      manager.recordCall("ses-1", "bash", `fp-${i}`, 2)
    }
    // fp-69 (newest) survived: second call reaches threshold 2.
    const rNewest = manager.recordCall("ses-1", "bash", "fp-69", 2)
    expect(rNewest).toBe(true)
    // fp-5 (among the 6 oldest, evicted) restarted at 1 → below threshold.
    const rOld = manager.recordCall("ses-1", "bash", "fp-5", 2)
    expect(rOld).toBe(false)
  })

  test("eviction is per-session — session A's key flood does not evict session B's keys", () => {
    const manager = createManager()
    for (let i = 0; i < 70; i++) {
      manager.recordCall("ses-a", "bash", `fp-${i}`, 2)
    }
    manager.recordCall("ses-b", "bash", "fp-keep", 2)
    // ses-b's key untouched: second call reaches threshold.
    const rB = manager.recordCall("ses-b", "bash", "fp-keep", 2)
    expect(rB).toBe(true)
  })

  test("clearAll empties all keyed state", () => {
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-aaa", 3)
    manager.recordCall("ses-1", "bash", "fp-bbb", 3)
    manager.recordCall("ses-2", "read", "fp-ccc", 3)

    manager.clearAll()

    // Every key restarted at 1 — two more calls stay below threshold 3.
    const r1 = manager.recordCall("ses-1", "bash", "fp-aaa", 3)
    const r2 = manager.recordCall("ses-1", "bash", "fp-aaa", 3)
    expect(r1).toBe(false)
    expect(r2).toBe(false)
  })
})

describe("isIgnored helper", () => {
  test("returns false when no ignore patterns configured", () => {
    const { isIgnored } = require("./cross-stream-doom-loop")
    const compiled = isIgnored([])
    expect(compiled(JSON.stringify({ path: "/.rules/test.mdc" }))).toBe(false)
  })

  test("returns true when input matches /\\.rules\\/ pattern", () => {
    const { isIgnored } = require("./cross-stream-doom-loop")
    const compiled = isIgnored(["/\\.rules\\/"])
    expect(compiled(JSON.stringify({ filePath: "/home/user/.rules/olho/always-apply/rules.mdc" }))).toBe(true)
  })

  test("returns true when input matches \\.mdc pattern", () => {
    const { isIgnored } = require("./cross-stream-doom-loop")
    const compiled = isIgnored(["\\.mdc"])
    expect(compiled(JSON.stringify({ filePath: "/some/path/file.mdc" }))).toBe(true)
  })

  test("returns false when input does not match any pattern", () => {
    const { isIgnored } = require("./cross-stream-doom-loop")
    const compiled = isIgnored(["/\\.rules\\/", "\\.mdc"])
    expect(compiled(JSON.stringify({ filePath: "/some/path/file.ts" }))).toBe(false)
  })

  test("returns false when input is empty string", () => {
    const { isIgnored } = require("./cross-stream-doom-loop")
    const compiled = isIgnored(["/\\.rules\\/"])
    expect(compiled("")).toBe(false)
  })

  test("compiled function is reused across calls (same instance)", () => {
    const { isIgnored } = require("./cross-stream-doom-loop")
    const compiled = isIgnored(["/\\.rules\\/"])
    const r1 = compiled(JSON.stringify({ path: "/.rules/test.mdc" }))
    const r2 = compiled(JSON.stringify({ path: "/.rules/test.mdc" }))
    expect(r1).toBe(true)
    expect(r2).toBe(true)
  })
})

describe("DoomLoopRunState interface", () => {
  test("state contains required fields", () => {
    // Verify the interface shape by checking that recordCall creates proper state
    const manager = createManager()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)

    // We can't directly inspect internal state (it's a Map), but the behavior
    // proves the state is correctly structured:
    // - toolName is part of the key (different tool tracks its own count)
    // - inputFingerprint is part of the key (different fp tracks its own count)
    // - count is tracked (increments on same tool+fp)

    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const r = manager.recordCall("ses-1", "bash", "fp-abc", 3)
    expect(r).toBe(true)

    // Different tool tracks its own count (starts at 1)
    manager.clearAll()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const r2 = manager.recordCall("ses-1", "ReadFile", "fp-abc", 3)
    expect(r2).toBe(false)

    // Different fingerprint tracks its own count (starts at 1)
    manager.clearAll()
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    manager.recordCall("ses-1", "bash", "fp-abc", 3)
    const r3 = manager.recordCall("ses-1", "bash", "fp-def", 3)
    expect(r3).toBe(false)
  })
})

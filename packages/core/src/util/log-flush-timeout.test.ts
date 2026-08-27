/**
 * Log.flush() timeout fallback (spec C3): resolves within ~timeoutMs even when
 * a stream write callback never fires. The fatal path awaits flush() before
 * process.exit() — it must never hang.
 *
 * The real file stream always fires its callback, so this file mocks "fs" to
 * return a stream whose write() never invokes the callback, simulating a
 * wedged stream. The rest of "fs" stays real (spread).
 */
import { test, expect, describe, afterAll, mock } from "bun:test"
import * as realFs from "fs"
import * as path from "path"
import { tmpdir } from "os"
import { rm } from "fs/promises"

let flushLogDir = ""
let lastWriteCallback: ((err?: Error) => void) | undefined

const neverResolvingStream = {
  write(_msg: string, cb?: (err?: Error) => void) {
    // Simulate a write whose callback never fires (e.g. a wedged stream).
    lastWriteCallback = cb
    return true
  },
}

mock.module("fs", () => ({
  ...realFs,
  createWriteStream: () => neverResolvingStream,
}))

mock.module("../global", () => {
  flushLogDir = realFs.mkdtempSync(path.join(tmpdir(), "log-flush-timeout-test-"))
  return { Path: { log: flushLogDir } }
})

import * as Log from "./log"

describe("Log.flush() timeout fallback", () => {
  afterAll(async () => {
    if (flushLogDir) await rm(flushLogDir, { recursive: true, force: true })
  })

  test("resolves within ~timeoutMs even when a write callback never fires (no hang)", async () => {
    await Log.init({ print: false, dev: true })

    Log.Default.error("never-flushed-marker")

    // The pending write never completes; flush must fall back to the timeout.
    const start = Date.now()
    await Log.flush(100)
    const elapsed = Date.now() - start

    // Waited for the timeout fallback rather than resolving instantly…
    expect(elapsed).toBeGreaterThanOrEqual(90)
    // …and did not hang past a generous bound.
    expect(elapsed).toBeLessThan(1000)
  })
})

import { test, expect, describe, afterAll } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Log } from "@opencode-ai/core/util/log"
import { McpAuth } from "../../src/mcp/auth"

/**
 * Test B — McpAuth.all() with a corrupt mcp-auth.json (ADR-10 / spec §3.2, §3.4).
 *
 * Path isolation: the repo test preload (test/preload.ts) sets XDG_DATA_HOME
 * to a per-process tmpdir BEFORE importing src, so Global.Path.data — and
 * auth.ts's module-scope `filepath` derived from it — is already isolated
 * from any real user data. No module mocking needed (existing tests follow
 * the same convention).
 *
 * Observable output: the preload kicks off an async Log.init({ print: false,
 * dev: true }) which, once complete, redirects the Log util's write sink
 * from stderr to dev.log (Global.Path.log/dev.log). We poll Log.file() to
 * wait for init, then observe the warning in dev.log via Log.flush() +
 * readFileSync — the same bytes a CLI user would see.
 */

// Wait for the preload's fire-and-forget Log.init({dev: true}) to finish so
// the log sink is deterministically the dev.log file (not a stderr race).
async function waitForLogInit(): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const file = Log.file()
    if (file) return file
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("Log.init did not complete — cannot observe log output")
}

const devLog = await waitForLogInit()

const authFile = path.join(Global.Path.data, "mcp-auth.json")
const WARNING = "mcp-auth.json read failed"

// The real corruption shape (two-part, observed in the field): strip the final
// `}` AND append a NUL byte. Written via Buffer so the raw bytes are guaranteed.
function writeCorruptAuthFile() {
  const valid = '{"server":{"tokens":{"accessToken":"x"}}}'
  const corrupt = valid.slice(0, -1) + "\u0000"
  fs.mkdirSync(Global.Path.data, { recursive: true })
  fs.writeFileSync(authFile, Buffer.from(corrupt, "utf8"))
}

function removeAuthFile() {
  fs.rmSync(authFile, { force: true })
}

async function runAll(): Promise<Record<string, unknown>> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const mc = yield* McpAuth.Service
      return yield* mc.all()
    }).pipe(Effect.provide(McpAuth.defaultLayer)),
  )
}

// Reads the dev.log content written since the `baseline` length.
async function logOutputSince(baseline: number): Promise<string> {
  await Log.flush(2000)
  return fs.readFileSync(devLog, "utf8").slice(baseline)
}

afterAll(() => {
  removeAuthFile()
})

describe("McpAuth corrupt mcp-auth.json (ADR-10)", () => {
  test("scenario A: corrupt file -> all() succeeds with {} AND warns", async () => {
    const baseline = fs.readFileSync(devLog, "utf8").length
    writeCorruptAuthFile()
    const data = await runAll()
    expect(data).toEqual({})
    const output = await logOutputSince(baseline)
    expect(output).toContain(WARNING)
  })

  test("scenario B: missing file -> all() succeeds with {} AND stays silent", async () => {
    const baseline = fs.readFileSync(devLog, "utf8").length
    removeAuthFile()
    const data = await runAll()
    expect(data).toEqual({})
    const output = await logOutputSince(baseline)
    expect(output).not.toContain(WARNING)
  })
})

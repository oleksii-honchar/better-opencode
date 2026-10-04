import { expect, test, describe } from "bun:test"
import * as path from "path"

// Flag.OTEL_EXPORTER_OTLP_ENDPOINT is captured at module-load time (flag.ts),
// so env manipulation inside this test process cannot change `base` in
// observability.ts. Each scenario imports the module in a fresh subprocess
// with a controlled environment and inspects the emitted log output.
const observabilityPath = path.join(import.meta.dir, "observability.ts")
const MESSAGE = "OTel telemetry disabled: OTEL_EXPORTER_OTLP_ENDPOINT not set"

const importScript = `await import(${JSON.stringify("file://" + observabilityPath)})`

function spawnBun(script: string, env: Record<string, string>) {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete childEnv.OTEL_EXPORTER_OTLP_ENDPOINT
  delete childEnv.OTEL_EXPORTER_OTLP_HEADERS
  for (const [key, value] of Object.entries(env)) childEnv[key] = value
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    env: childEnv,
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    output: proc.stdout.toString() + proc.stderr.toString(),
    exitCode: proc.exitCode,
  }
}

function warnLines(output: string) {
  return output.split("\n").filter((line) => line.includes(MESSAGE))
}

describe("observability telemetry-disabled startup warning", () => {
  test("emits exactly one telemetry-disabled warning when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
    const result = spawnBun(importScript, {})
    expect(result.exitCode).toBe(0)
    expect(warnLines(result.output).length).toBe(1)
  })

  test("emits no telemetry-disabled warning when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    const result = spawnBun(importScript, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" })
    expect(result.exitCode).toBe(0)
    expect(warnLines(result.output).length).toBe(0)
  })

  test("warns at most once per process regardless of repeated initialization", () => {
    // Same process: import the module, touch the exported layer repeatedly,
    // then re-import (module cache) — the warning must still appear only once.
    const script = [
      `const m = ${importScript}`,
      "void m.enabled; void m.layer; void m.Observability.enabled; void m.Observability.layer",
      importScript,
      importScript,
    ].join("; ")
    const result = spawnBun(script, {})
    expect(result.exitCode).toBe(0)
    expect(warnLines(result.output).length).toBe(1)
  })
})

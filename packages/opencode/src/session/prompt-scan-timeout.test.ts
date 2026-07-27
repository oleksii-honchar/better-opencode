import { describe, test, expect } from "bun:test"
import * as Effect from "effect/Effect"
import { readFileSync } from "fs"
import { resolve } from "path"

// ---------------------------------------------------------------------------
// Prompt Scan Timeout Verification Test
//
// Verifies that prompt.ts applies a 3-second timeout to the forked scanParts
// call BEFORE Effect.forkChild. This is a structural verification test that
// reads the source code to ensure the timeout is present in the correct order.
// ---------------------------------------------------------------------------

describe("prompt.ts fork timeout verification", () => {
  const promptPath = resolve(__dirname, "prompt.ts")

  function readPromptSource(): string {
    return readFileSync(promptPath, "utf-8")
  }

  // Helper: extract the pipe body from the scanParts call
  function extractScanPartsPipeBody(source: string): string | null {
    // Find scanParts call start
    const startIdx = source.indexOf("DynamicSkillScanner.scanParts(")
    if (startIdx === -1) return null

    // Look for the pattern: scanParts args end with ), then .pipe( on the same or next line
    // The scanParts call ends with: info.model?.modelID ?? ModelID.make("default"),\n      ).pipe(
    const afterStart = source.slice(startIdx)

    // Find the closing of scanParts arguments: look for the line with ).pipe(
    // that comes after the last argument line
    const lines = afterStart.split("\n")
    let pipeLineIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(").pipe(")) {
        pipeLineIdx = i
        break
      }
    }

    if (pipeLineIdx === -1) return null

    // Reconstruct from that point and find the pipe body
    const fromPipeLine = lines.slice(pipeLineIdx).join("\n")

    // Extract content between .pipe( and its matching )
    const pipeParenIdx = fromPipeLine.indexOf(".pipe(")
    if (pipeParenIdx === -1) return null

    // Start counting from after .pipe(
    let depth = 1
    let pipeEndIdx = -1
    for (let i = pipeParenIdx + 6; i < fromPipeLine.length; i++) {
      if (fromPipeLine[i] === "(") depth++
      if (fromPipeLine[i] === ")") {
        depth--
        if (depth === 0) {
          pipeEndIdx = i
          break
        }
      }
    }

    if (pipeEndIdx === -1) return null

    return fromPipeLine.slice(pipeParenIdx + 6, pipeEndIdx).trim()
  }

  test("scanParts call has Effect.timeout(3000) before Effect.forkChild", () => {
    const source = readPromptSource()
    const pipeBody = extractScanPartsPipeBody(source)

    expect(pipeBody).not.toBeNull()

    // Verify Effect.timeout(3000) exists in the pipe
    expect(pipeBody).toContain("Effect.timeout(3000)")

    // Verify order: timeout comes before forkChild
    const timeoutIndex = pipeBody!.indexOf("Effect.timeout(3000)")
    const forkChildIndex = pipeBody!.indexOf("Effect.forkChild")

    expect(timeoutIndex).toBeGreaterThan(-1)
    expect(forkChildIndex).toBeGreaterThan(-1)
    expect(timeoutIndex).toBeLessThan(forkChildIndex)
  })

  test("scanParts call has Effect.ignore after Effect.forkChild", () => {
    const source = readPromptSource()
    const pipeBody = extractScanPartsPipeBody(source)

    expect(pipeBody).not.toBeNull()

    // Verify Effect.ignore exists
    expect(pipeBody).toContain("Effect.ignore")

    // Verify order: forkChild comes before ignore
    const forkChildIndex = pipeBody!.indexOf("Effect.forkChild")
    const ignoreIndex = pipeBody!.indexOf("Effect.ignore")

    expect(forkChildIndex).toBeGreaterThan(-1)
    expect(ignoreIndex).toBeGreaterThan(-1)
    expect(forkChildIndex).toBeLessThan(ignoreIndex)
  })

  test("timeout value is exactly 3000ms", () => {
    const source = readPromptSource()
    const pipeBody = extractScanPartsPipeBody(source)

    expect(pipeBody).not.toBeNull()

    // Must contain timeout(3000) specifically
    expect(pipeBody).toMatch(/Effect\.timeout\(3000\)/)
  })
})

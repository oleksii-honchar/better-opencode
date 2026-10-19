import { describe, test, expect } from "bun:test"
import * as path from "path"
import * as os from "os"
import { normalizeSessionPathShape } from "./session-path-guard"

// Unit tests for the pure contract pinned by spec §5 + §3.3 (session-path-guard).
// Fixtures mirror the shared history.mjs `guardSessionPathShape` vocabulary (DEC-6)
// and pin shape-only normalization — no calendar validation (DEC-5).
// Hermetic: the function is pure string manipulation, roots are temp-dir path
// STRINGS under os.tmpdir() (never created on disk, ~/.agent-sessions never touched).

// Unique temp root string (path.join of tmpdir + unique segment).
const root = path.join(os.tmpdir(), "session-path-guard-test-root")

describe("normalizeSessionPathShape", () => {
  test("flat date first segment under explicit custom root is normalized to nested form", () => {
    expect(normalizeSessionPathShape(`${root}/26-10-19/x`, root)).toBe(`${root}/26/10/19/x`)
  })

  test("default-root code path honors AGENT_SESSIONS_DIR (spec §3.1 resolver)", () => {
    const previous = process.env.AGENT_SESSIONS_DIR
    try {
      process.env.AGENT_SESSIONS_DIR = root
      // No explicit root argument — resolver must read the env var.
      expect(normalizeSessionPathShape(`${root}/26-10-19/x`)).toBe(`${root}/26/10/19/x`)
    } finally {
      if (previous === undefined) delete process.env.AGENT_SESSIONS_DIR
      else process.env.AGENT_SESSIONS_DIR = previous
    }
  })

  test("literal ~/.agent-sessions prefix is normalized with tilde kept literal", () => {
    expect(normalizeSessionPathShape("~/.agent-sessions/26-10-18/y", root)).toBe(
      "~/.agent-sessions/26/10/18/y",
    )
  })

  test("relative path resolving under the root returns the absolute nested form", () => {
    // path.resolve() anchors at process.cwd(), so the only hermetic root this
    // case can use IS the cwd passed explicitly — no FS writes, no chdir.
    const cwd = process.cwd()
    expect(normalizeSessionPathShape("./26-10-19/x", cwd)).toBe(path.join(cwd, "26", "10", "19", "x"))
  })

  test("flat leaf at end of path (no trailing segment) is normalized — (/|$) lookahead", () => {
    expect(normalizeSessionPathShape(`${root}/26-10-18`, root)).toBe(`${root}/26/10/18`)
  })

  test("already-nested path returns undefined (no-op)", () => {
    expect(normalizeSessionPathShape(`${root}/26/10/19/x`, root)).toBeUndefined()
  })

  test("path outside the sessions root returns undefined — reports-style path", () => {
    expect(normalizeSessionPathShape("/tmp/reports/26-10-18/x", root)).toBeUndefined()
  })

  test("path outside the sessions root returns undefined — flat segment under foreign root", () => {
    expect(normalizeSessionPathShape("/tmp/26-10-18/x", root)).toBeUndefined()
  })

  test("four-digit year first segment returns undefined (shape is NN-NN-NN only)", () => {
    expect(normalizeSessionPathShape(`${root}/1999-01-01/x`, root)).toBeUndefined()
  })

  test("flat form in a non-first segment returns undefined — archive/ layout untouched (DEC-3)", () => {
    expect(normalizeSessionPathShape(`${root}/archive/26-10-18`, root)).toBeUndefined()
  })

  test("99-99-99 is normalized to 99/99/99 — shape rule, not calendar (DEC-5)", () => {
    expect(normalizeSessionPathShape(`${root}/99-99-99/probe`, root)).toBe(`${root}/99/99/99/probe`)
  })
})

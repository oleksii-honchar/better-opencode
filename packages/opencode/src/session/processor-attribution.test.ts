import { describe, expect, test } from "bun:test"
import { attributePatchFiles } from "@/session/processor"

// ---------------------------------------------------------------------------
// Task 6 (Workstream F, E11) — cross-session patch attribution.
//
// Incident shape: two sessions run CONCURRENTLY in the same project/worktree
// (e.g. directory `/Users/x/.agent-sessions`). The Snapshot service state is
// per-project (one shared snapshot gitdir), so `snapshot.patch(stepStartHash)`
// returns EVERY file changed in the worktree since the step started — including
// files edited only by the OTHER session. Pre-fix, `processor.ts` wrote that
// whole list into a `patch` part owned by whichever session finished a step,
// so 70 patch parts snapshotting session B's files (`261003-1007-strata-…`)
// appeared inside session A's history although session A never edited files.
//
// Contract under test: a patch part may only contain files the OWNING session's
// tool calls actually touched. `attributePatchFiles(patchFiles, touchedFiles)`
// is the attribution decision made at the patch-part emission sites
// (step-finish + cleanup). Pre-fix this behavior does not exist — the emission
// sites pass `patch.files` through unfiltered — so this suite fails RED.
// ---------------------------------------------------------------------------

const sessionAFile = "/Users/dev/.agent-sessions/26/10/03/session-a/notes.md"
const sessionBFile = "/Users/dev/.agent-sessions/26/10/03/261003-1007-strata-mammoth-qwen-5090/history.jsonl"

describe("attributePatchFiles — two concurrent sessions, one shared snapshot worktree", () => {
  test("incident shape: session A touched no files, session B edited concurrently → A gets no patch files", () => {
    // Session A's tools were MCP-only (getPersonaEntryNode/recallMemory).
    // The shared-worktree snapshot diff returns session B's file (and a file A
    // also did not touch). None may be attributed to A.
    const sharedWorktreeDiff = [sessionAFile, sessionBFile]
    const touchedBySessionA: string[] = []

    expect(attributePatchFiles(sharedWorktreeDiff, new Set(touchedBySessionA))).toEqual([])
  })

  test("session A edited its own file while session B edited its own → A keeps only its own file", () => {
    const sharedWorktreeDiff = [sessionAFile, sessionBFile]
    const touchedBySessionA = [sessionAFile]

    expect(attributePatchFiles(sharedWorktreeDiff, new Set(touchedBySessionA))).toEqual([sessionAFile])
  })

  test("session B's history keeps its own file when B finishes a step (attribution is per-owner, not first-come)", () => {
    const sharedWorktreeDiff = [sessionAFile, sessionBFile]
    const touchedBySessionB = [sessionBFile]

    expect(attributePatchFiles(sharedWorktreeDiff, new Set(touchedBySessionB))).toEqual([sessionBFile])
  })

  test("original patch-file strings are preserved verbatim in the output", () => {
    const attributed = attributePatchFiles([sessionAFile], new Set([sessionAFile]))
    expect(attributed).toEqual([sessionAFile])
  })
})

describe("attributePatchFiles — path matching rules", () => {
  test("relative tool-input paths match absolute snapshot paths on segment boundaries", () => {
    // Tool inputs may be relative (`a/one.md`); snapshot paths are absolute
    // worktree paths. Matching must be segment-aware.
    const attributed = attributePatchFiles(["/work/a/one.md", "/work/b/two.md"], new Set(["a/one.md"]))
    expect(attributed).toEqual(["/work/a/one.md"])
  })

  test("suffix similarity without a path-segment boundary never matches", () => {
    // `/work/xtwo.md` must NOT be attributed from touched `two.md`.
    const attributed = attributePatchFiles(["/work/xtwo.md"], new Set(["two.md"]))
    expect(attributed).toEqual([])
  })

  test("backslash-separated touched paths match forward-slash snapshot paths", () => {
    // snapshot/index.ts normalizes patch.files to forward slashes; tool inputs
    // on Windows may carry backslashes.
    const attributed = attributePatchFiles(["C:/work/a/one.md"], new Set(["C:\\work\\a\\one.md"]))
    expect(attributed).toEqual(["C:/work/a/one.md"])
  })

  test("empty snapshot diff attributes nothing regardless of touched set", () => {
    expect(attributePatchFiles([], new Set([sessionAFile]))).toEqual([])
  })
})

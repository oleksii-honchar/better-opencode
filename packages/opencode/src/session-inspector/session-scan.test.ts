import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "path"
import { HttpServerResponse } from "effect/unstable/http"
import { scanSessionFolders, type ScanIO, type ScanRecord } from "./session-scan"
import { sessionsScanHttpResponse } from "./routes"
import { composeSessionFolder, tempDirs, writeSessionFolder } from "./session-inspector.test-utils"

// Task 3 AC2/AC3 — folder-scan mirroring the reminders.ts walk convention:
// session.md with a `sessionId:` frontmatter line (same extraction), ≥1 non-empty
// history.jsonl line for full scaffold validity; depth limit starts at 4 and
// decrements per level (the top dir itself is depth 0 and is checked).
// Implementation choice (recorded per plan): folder discovered with valid frontmatter
// but empty/absent history IS reported, with an explicit `scaffoldIncomplete: true`
// marker — degraded, never silent.

type RecordingIO = ScanIO & { reads: string[]; dirs: string[] }

function recordingIO(): RecordingIO {
  const reads: string[] = []
  const dirs: string[] = []
  return {
    reads,
    dirs,
    read: (p: string) => {
      reads.push(p)
      try {
        return readFileSync(p, "utf8")
      } catch {
        return undefined
      }
    },
    readDir: (p: string) => {
      dirs.push(p)
      try {
        return readdirSync(p)
      } catch {
        return undefined
      }
    },
  }
}

function collect(iterable: Iterable<ScanRecord>): ScanRecord[] {
  return [...iterable]
}

function nodeScanIO(): ScanIO {
  return {
    readDir: (dir: string) => {
      try {
        return readdirSync(dir)
      } catch {
        return undefined
      }
    },
    read: (file: string) => {
      try {
        return existsSync(file) ? readFileSync(file, "utf8") : undefined
      } catch {
        return undefined
      }
    },
  }
}

describe("scan — frontmatter/scaffold semantics (AC2)", () => {
  test("valid folders emit records with folderOnly; bad/absent frontmatter is skipped; empty/absent history marks scaffoldIncomplete; stream never aborts", () => {
    const dirs = tempDirs()
    try {
      const root = dirs.agentsDir
      const goodFull = composeSessionFolder(root, "261103", "2100", "scanfull")
      writeSessionFolder(goodFull, { sessionId: "ses_scan_full", title: "Alpha Rollout", timeCreated: "2026-11-03T21:00:00Z" })
      const goodMin = composeSessionFolder(root, "261103", "2105", "scanmin")
      writeSessionFolder(goodMin, { sessionId: "ses_scan_min" })
      const noFm = path.join(root, "plain-no-frontmatter")
      writeSessionFolder(noFm, { sessionId: "ignored_no_fm", noFrontmatter: true })
      const badFm = path.join(root, "orphan-frontmatter")
      writeSessionFolder(badFm, { sessionId: "ignored_bad_fm", badFrontmatter: true })
      const emptyHist = path.join(root, "empty-history")
      writeSessionFolder(emptyHist, { sessionId: "ses_empty_hist", history: "\n\n   \n" })
      const noHist = path.join(root, "no-history-file")
      writeSessionFolder(noHist, { sessionId: "ses_no_hist_file", noHistory: true })
      const garbageHist = path.join(root, "garbage-history")
      writeSessionFolder(garbageHist, { sessionId: "ses_garbage_hist", history: "~~~ not json but non-empty ~~~\n" })

      const records = collect(scanSessionFolders({ roots: [root, path.join(root, "does-not-exist-root")], io: recordingIO() }))
      const byId = new Map(records.map((r) => [r.sessionId, r]))

      expect([...byId.keys()].sort()).toEqual([
        "ses_empty_hist",
        "ses_garbage_hist",
        "ses_no_hist_file",
        "ses_scan_full",
        "ses_scan_min",
      ])

      const full = byId.get("ses_scan_full")!
      expect(full.folderPath).toBe(goodFull)
      expect(full.folderOnly).toBe(true)
      expect(full.title).toBe("Alpha Rollout")
      expect(full.timeCreated).toBe("2026-11-03T21:00:00Z")
      expect(full.scaffoldIncomplete).toBeUndefined()

      const min = byId.get("ses_scan_min")!
      expect("title" in min).toBe(false)
      expect("timeCreated" in min).toBe(false)
      expect("scaffoldIncomplete" in min).toBe(false)

      expect(byId.get("ses_empty_hist")!.scaffoldIncomplete).toBe(true)
      expect(byId.get("ses_no_hist_file")!.scaffoldIncomplete).toBe(true)
      expect(byId.get("ses_garbage_hist")!.scaffoldIncomplete).toBeUndefined()
      expect(byId.has("ignored_no_fm")).toBe(false)
      expect(byId.has("ignored_bad_fm")).toBe(false)
    } finally {
      dirs.cleanup()
    }
  })

  test("depth cap mirrors the walk: dirs at depth 0..4 are found, depth 5 is not, no abort", () => {
    const dirs = tempDirs()
    try {
      const root = dirs.agentsDir
      // depth 0: the root itself is a session folder
      writeSessionFolder(root, { sessionId: "ses_depth_0" })
      // depth 4: root/d1/d2/d3/d4
      const deep4 = path.join(root, "d1", "d2", "d3", "d4")
      writeSessionFolder(deep4, { sessionId: "ses_depth_4" })
      // depth 5: root/e1/e2/e3/e4/e5
      const deep5 = path.join(root, "e1", "e2", "e3", "e4", "e5")
      writeSessionFolder(deep5, { sessionId: "ses_depth_5" })

      const ids = collect(scanSessionFolders({ roots: [root], io: recordingIO() })).map((r) => r.sessionId).sort()
      expect(ids).toEqual(["ses_depth_0", "ses_depth_4"])
    } finally {
      dirs.cleanup()
    }
  })
})

describe("scan — roots handling and determinism", () => {
  test("duplicate normalized roots contribute once; entries walk in sorted order", () => {
    const dirs = tempDirs()
    try {
      const root = dirs.agentsDir
      writeSessionFolder(path.join(root, "bbb-session"), { sessionId: "ses_b" })
      writeSessionFolder(path.join(root, "aaa-session"), { sessionId: "ses_a" })

      const once = collect(scanSessionFolders({ roots: [root], io: recordingIO() }))
      expect(once.map((r) => r.sessionId)).toEqual(["ses_a", "ses_b"])

      const twice = collect(scanSessionFolders({ roots: [root, root + "/"], io: recordingIO() }))
      expect(twice.map((r) => r.sessionId)).toEqual(["ses_a", "ses_b"])
    } finally {
      dirs.cleanup()
    }
  })

  test("stream independence: first line is produced before the deep decoy subtree is touched", () => {
    const dirs = tempDirs()
    try {
      const root = dirs.agentsDir
      // decoy subtree: session dir at depth 4 (inside the walk limit), positioned
      // lexicographically AFTER the quick folder so laziness is observable.
      writeSessionFolder(path.join(root, "bbbb-decoy-deep", "x1", "x2", "x3"), { sessionId: "ses_decoy" })
      writeSessionFolder(path.join(root, "aaaa-quick"), { sessionId: "ses_quick" })

      const io = recordingIO()
      const it = scanSessionFolders({ roots: [root], io })[Symbol.iterator]()
      const first = it.next().value as ScanRecord
      expect(first.sessionId).toBe("ses_quick")
      expect(io.reads.some((p) => p.includes("bbbb-decoy-deep"))).toBe(false)
      expect(io.dirs.some((p) => p.includes("bbbb-decoy-deep"))).toBe(false)

      const rest: ScanRecord[] = []
      for (const r of { [Symbol.iterator]: () => it } as Iterable<ScanRecord>) rest.push(r)
      expect(rest.map((r) => r.sessionId)).toEqual(["ses_decoy"])
    } finally {
      dirs.cleanup()
    }
  })
})

describe("scan endpoint — NDJSON media type and line bytes (AC3, §6.6/DEC-M)", () => {
  test("200 application/x-ndjson, no Content-Length, every line independently JSON.parse-able", async () => {
    const dirs = tempDirs()
    try {
      const root = dirs.agentsDir
      writeSessionFolder(path.join(root, "one"), { sessionId: "ses_nd_1", title: "One" })
      writeSessionFolder(path.join(root, "two-empty"), { sessionId: "ses_nd_2", noHistory: true })

      const response = sessionsScanHttpResponse(
        new URLSearchParams(`roots=${encodeURIComponent(root)}`),
        {
          configPath: path.join(dirs.configDir, "session-inspector.json"),
          configIo: { read: () => ({ kind: "missing" as const }) },
          baseDirs: { configDir: dirs.configDir, agentsDir: "", logsDir: "" },
          io: nodeScanIO(),
        },
      )
      const web = HttpServerResponse.toWeb(response)
      expect(web.status).toBe(200)
      expect(web.headers.get("content-type")).toBe("application/x-ndjson")
      expect(web.headers.get("content-length")).toBe(null)

      const text = await web.text()
      expect(text.endsWith("\n")).toBe(true)
      const lines = text.split("\n").filter((l) => l.trim().length > 0)
      const parsed = lines.map((l) => JSON.parse(l) as { sessionId: string; scaffoldIncomplete?: boolean })
      expect(parsed.map((p) => p.sessionId).sort()).toEqual(["ses_nd_1", "ses_nd_2"])
      expect(parsed.filter((p) => p.scaffoldIncomplete === true).map((p) => p.sessionId)).toEqual(["ses_nd_2"])
      const cfgPath = path.join(dirs.configDir, "session-inspector.json")
      expect(existsSync(cfgPath)).toBe(false)
    } finally {
      dirs.cleanup()
    }
  })

  test("config agentsRoot contributes without any roots param; unknown params ignored; bad roots entry -> 400 observed shape", async () => {
    const dirs = tempDirs()
    try {
      writeSessionFolder(path.join(dirs.agentsDir, "from-config"), { sessionId: "ses_from_config" })
      const deps = {
        configPath: path.join(dirs.configDir, "session-inspector.json"),
        configIo: { read: () => ({ kind: "missing" as const }) },
        baseDirs: { configDir: dirs.configDir, agentsDir: dirs.agentsDir, logsDir: dirs.logsDir },
        io: nodeScanIO(),
      }
      const ok = sessionsScanHttpResponse(new URLSearchParams("bogus=1"), deps)
      const web = HttpServerResponse.toWeb(ok)
      expect(web.status).toBe(200)
      const lines = (await web.text()).split("\n").filter((l) => l.trim().length > 0)
      expect(lines.length).toBe(1)
      expect(JSON.parse(lines[0]).sessionId).toBe("ses_from_config")

      // relative roots entries are rejected with the observed BadRequest shape
      const bad = HttpServerResponse.toWeb(sessionsScanHttpResponse(new URLSearchParams("roots=not-absolute"), deps))
      expect(bad.status).toBe(400)
      const body = (await bad.json()) as { name: string; data: { message: string } }
      expect(body.name).toBe("BadRequest")
      expect(body.data.message).toContain("roots")
    } finally {
      dirs.cleanup()
    }
  })
})

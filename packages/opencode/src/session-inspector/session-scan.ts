import path from "node:path"

// GET /session-inspector/sessions/scan — session-folder discovery (§5.1-1),
// mirroring the authoritative walk convention measured in
// `src/session/reminders.ts` (L155–189 at 4dc7a5d31):
//   - `sessionId:` frontmatter extraction: identical regex incl. quote-stripping
//   - scaffold validity: ≥1 non-blank line in history.jsonl (same filter)
//   - traversal: the top dir itself is depth 0 and is checked; initial depth
//     limit 4 decrementing per level — i.e. session folders up to 4 directory
//     levels below a root are found (mirrors walkForSession(io, dir, id, 4))
//
// Deliberate differences from the scaffold check (this is a scanner, not a
// per-session verifier): it COLLECTS every well-formed folder instead of
// searching one id and stopping, and a folder with valid frontmatter whose
// history is empty/absent is still REPORTED with an explicit
// `scaffoldIncomplete: true` marker (recorded implementation choice per plan —
// degraded, never silent). Entries are visited in sorted order so the NDJSON
// stream is deterministic. `folderOnly: true` marks folder-discovered sessions
// (the DB is never consulted here; the join is the client's per §7).
//
// The generator is lazy per directory: a slow deep subtree cannot delay the
// emission of earlier lines (asserted in tests). io failures end a subtree,
// they never abort the stream.

export interface ScanIO {
  readDir: (dir: string) => string[] | undefined
  read: (file: string) => string | undefined
}

export interface ScanRecord {
  sessionId: string
  folderPath: string
  title?: string
  timeCreated?: string
  folderOnly: true
  scaffoldIncomplete?: true
}

const SCAN_DEPTH_LIMIT = 4

// verbatim from reminders.ts sessionIDFromFrontmatter
function sessionIdFromFrontmatter(text: string): string | undefined {
  const match = text.match(/^sessionId:\s*(\S+)/m)
  return match?.[1]?.replace(/^["']|["']$/g, "")
}

function frontmatterField(text: string, name: string): string | undefined {
  const match = text.match(new RegExp(`^${name}:[ \\t]*(.*?)\\s*$`, "m"))
  const value = match?.[1]?.replace(/^["']|["']$/g, "")
  return value !== undefined && value.length > 0 ? value : undefined
}

export interface ScanInput {
  roots: string[]
  io: ScanIO
}

export function* scanSessionFolders(input: ScanInput): Generator<ScanRecord> {
  const seenRoots = new Set<string>()
  for (const root of input.roots) {
    // duplicate/overlapping root listings contribute each folder once (normalized);
    // non-existent roots are silently absent (walk of nothing yields nothing).
    const normalized = path.resolve(root)
    if (seenRoots.has(normalized)) continue
    seenRoots.add(normalized)
    yield* walkDirectory(input.io, normalized, SCAN_DEPTH_LIMIT)
  }
}

function* walkDirectory(io: ScanIO, dir: string, depth: number): Generator<ScanRecord> {
  if (depth < 0) return

  const markdown = io.read(path.join(dir, "session.md"))
  if (markdown !== undefined) {
    const sessionId = sessionIdFromFrontmatter(markdown)
    if (sessionId !== undefined) {
      const history = io.read(path.join(dir, "history.jsonl"))
      const scaffoldComplete = history !== undefined && history.split("\n").some((line) => line.trim().length > 0)
      // key insertion order = stable JSON field order on the wire
      const record: ScanRecord = { sessionId, folderPath: dir, folderOnly: true }
      const title = frontmatterField(markdown, "title")
      if (title !== undefined) record.title = title
      const timeCreated = frontmatterField(markdown, "timeCreated")
      if (timeCreated !== undefined) record.timeCreated = timeCreated
      if (!scaffoldComplete) record.scaffoldIncomplete = true
      yield record
    }
  }

  if (depth === 0) return
  const entries = io.readDir(dir)
  if (entries === undefined) return
  for (const name of [...entries].sort()) {
    yield* walkDirectory(io, path.join(dir, name), depth - 1)
  }
}

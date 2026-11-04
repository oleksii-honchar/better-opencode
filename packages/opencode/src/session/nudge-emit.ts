import fs from "node:fs"
import path from "node:path"
import * as Log from "@opencode-ai/core/util/log"
import { loadInspectorConfig } from "@/session-inspector/config"
import { productionConfigDeps, productionResolveSessionPath } from "@/session-inspector/routes"
import type { ResolveOutcome } from "@/session-inspector/session-path"

// Task 8 — plugin.nudge attribution (DEC-H; spec §5.2 emitter discipline; §8 default-OFF).
//
// The engine emits ONE history line per synthetic reminder part appended, through an
// in-process writer that reproduces the SHIPPED history.mjs append discipline
// byte-for-byte (spec §5.2 explicitly allows "script-side emitter or in-process writer
// reproducing the same line shape"; the hot-turn path rules out a per-emit node spawn
// of history.mjs itself). Evidence includes a measured line-by-line byte comparison
// of BOTH writer paths against the same fixture. The shipped history.mjs stays
// UNMODIFIED and is still the canonical writer for everything else.
//
// Reproduced discipline (mirrored from agents/scripts/history.mjs, kept in sync):
//   - line = JSON.stringify(record); key order [ts, sessionId, agent, event, details,
//     nextAgent, phase, status] plus conditional [subAgentSessionId, parentSessionId]
//     derived from OPENCODE_SESSION_ID (trim-to-empty rule, parent only when different);
//   - sessionId comes from the session.md FRONTMATTER (identity), never the queried id;
//   - session.md is never written;
//   - migrate-on-adopt: no history.jsonl yet + hand-written agentSessions frontmatter
//     → adopted `started` lines are appended BEFORE the new line, in the same write;
//   - file is only ever opened with flag "a" (created on first write).
// NEVER THROWS (AC): every failure (resolver miss, missing/broken session.md, unwritable
// journal) is swallowed into a debug log entry; the reminder flow stays byte-identical.

export type NudgeKind = "scaffold-reminder" | "plan-switch" | "plan-mode"

export interface NudgeInfo {
  sessionID: string
  kind: NudgeKind
  /** The exact text appended to the transcript (injected_bytes measures this). */
  text: string
  /** Real synthetic part id pushed/persisted for this append (ref_part_id carrier). */
  partID: string
}

export interface NudgeEmitDeps {
  enabled: () => boolean
  sessionDir: (sessionID: string) => ResolveOutcome
  readFile: (p: string) => string | undefined
  appendLine: (p: string, line: string) => void
  env?: Record<string, string | undefined>
  debug?: (msg: string) => void
}

// --- frontmatter parsing (mirrors history.mjs parseFrontmatter/findFrontmatterEnd) ---

const stripQuotes = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

function findFrontmatterEnd(text: string): number | null {
  if (!text.startsWith("---")) return null
  const lines = text.split(/\r?\n/)
  let acc = lines[0]!.length + 1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "---") {
      return acc + line.length + (acc + line.length < text.length && text[acc + line.length] === "\n" ? 1 : 0)
    }
    acc += line.length + 1
  }
  return null
}

interface Frontmatter {
  sessionId: string | null
  agentSessions: Array<{ agent: string; sessionId?: string; startedAt?: string }>
}

function parseFrontmatter(text: string): Frontmatter | null {
  const fmEnd = findFrontmatterEnd(text)
  if (fmEnd == null) return null
  const fmRaw = text.slice(0, fmEnd)
  const fmLines = fmRaw.split(/\r?\n/).slice(1).filter((l) => l.trim() !== "---")

  const scalars: Record<string, string | null> = {}
  const agentSessions: Frontmatter["agentSessions"] = []
  let cur: Frontmatter["agentSessions"][number] | null = null
  let inAgents = false

  for (const line of fmLines) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    const indent = (line.match(/^[ \t]*/) || [""])[0]!.length

    if (indent === 0) {
      const topKey = /^([A-Za-z][A-Za-z0-9_-]*)\s*:/.exec(trimmed)
      inAgents = false
      cur = null
      if (topKey) {
        const k = topKey[1]!
        if (k === "agentSessions") {
          inAgents = true
          continue
        }
        scalars[k] = stripQuotes(trimmed.slice(k.length + 1).trim())
      }
      continue
    }

    if (inAgents && indent >= 2 && /^-\s*agent:/.test(trimmed)) {
      const obj = { agent: stripQuotes(trimmed.replace(/^-\s*agent:\s*/, "")) ?? "" }
      agentSessions.push(obj)
      cur = obj
      continue
    }

    if (cur && inAgents && indent >= 4) {
      const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(trimmed)
      if (kv) (cur as Record<string, unknown>)[kv[1]!] = stripQuotes(kv[2])
    }
  }

  return { sessionId: scalars.sessionId ?? null, agentSessions }
}

// --- record builder (mirrors history.mjs runWrite record shape) ----------------

export function buildNudgeRecord(
  sessionId: string | null,
  info: NudgeInfo,
  env: Record<string, string | undefined>,
  ts: string,
): Record<string, unknown> {
  const details = JSON.stringify({
    emitter: "engine",
    kind: info.kind,
    injected_bytes: Buffer.byteLength(info.text, "utf8"),
    ref_part_id: info.partID,
  })

  const record: Record<string, unknown> = {
    ts,
    sessionId,
    agent: "engine", // §5.2: agent id = engine/plugin id for plugin.* events, never the persona
    event: "plugin.nudge",
    details,
    nextAgent: null,
    phase: null,
    status: null,
  }

  const subAgentSessionId = (env["OPENCODE_SESSION_ID"] || "").trim() || null
  if (subAgentSessionId) {
    record.subAgentSessionId = subAgentSessionId
    if (subAgentSessionId !== sessionId) record.parentSessionId = sessionId
  }
  return record
}

export function makeNudgeEmit(deps: NudgeEmitDeps): (info: NudgeInfo) => void {
  return (info) => {
    try {
      // Default-OFF gate (§8). Consumed through the session-inspector config surface —
      // never a point-of-use process.env read (config schema `emitters.pluginNudgeHistory`).
      if (!deps.enabled()) return

      const dir = deps.sessionDir(info.sessionID)
      if (!dir.ok) {
        deps.debug?.(`plugin.nudge skipped (${info.kind}): ${dir.reason}`)
        return
      }

      const sessionMd = deps.readFile(path.join(dir.path, "session.md"))
      if (sessionMd === undefined) {
        deps.debug?.(`plugin.nudge skipped (${info.kind}): missing session.md in ${dir.path}`)
        return
      }
      const parsed = parseFrontmatter(sessionMd.replace(/^\uFEFF/, ""))
      if (!parsed) {
        deps.debug?.(`plugin.nudge skipped (${info.kind}): session.md in ${dir.path} has no valid frontmatter`)
        return
      }

      const historyPath = path.join(dir.path, "history.jsonl")

      // MIGRATE-ON-ADOPT (history.mjs discipline, faithful): adopted lines first, one write.
      const pending: string[] = []
      if (!fs.existsSync(historyPath) && parsed.agentSessions.length > 0) {
        for (const ent of parsed.agentSessions) {
          pending.push(
            JSON.stringify({
              ts: ent.startedAt || new Date().toISOString(),
              sessionId: ent.sessionId || parsed.sessionId,
              agent: ent.agent,
              event: "started",
              details: null,
              nextAgent: null,
              phase: null,
              status: null,
            }),
          )
        }
      }

      const line = JSON.stringify(buildNudgeRecord(parsed.sessionId, info, deps.env ?? process.env, new Date().toISOString()))
      if (line.length < 10) {
        deps.debug?.(`plugin.nudge skipped (${info.kind}): serialized line empty or malformed`)
        return
      }

      deps.appendLine(historyPath, [...pending, line].join("\n"))
    } catch (error) {
      // AC: a history-write failure must never reach the reminder flow.
      deps.debug?.(`plugin.nudge emit failed (${info.kind}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// --- production wiring ----------------------------------------------------------

const log = Log.create({ service: "session-inspector/nudge" })

function productionEnabled(): boolean {
  try {
    const deps = productionConfigDeps()
    const result = loadInspectorConfig({ configPath: deps.configPath, io: deps.io, baseDirs: deps.baseDirs })
    if (!result.ok) {
      log.info("plugin.nudge skipped: config invalid", { path: result.path })
      return false
    }
    return result.config.emitters.pluginNudgeHistory
  } catch (error) {
    log.info("plugin.nudge gate failed", { error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

function productionSessionDir(sessionID: string): ResolveOutcome {
  const deps = productionConfigDeps()
  return productionResolveSessionPath(sessionID, deps.baseDirs.agentsDir)
}

// Bounded to a plain append — the emit() wrapper owns every failure path.
const productionAppendLine = (p: string, line: string): void => {
  fs.appendFileSync(p, line + "\n", { encoding: "utf8", flag: "a" })
}

export const productionNudgeEmit: (info: NudgeInfo) => void = makeNudgeEmit({
  enabled: productionEnabled,
  sessionDir: productionSessionDir,
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8")
    } catch {
      return undefined
    }
  },
  appendLine: productionAppendLine,
  debug: (msg) => log.info(msg),
})

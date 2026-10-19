import type { Plugin } from "@opencode-ai/plugin"
import * as path from "path"
import * as os from "os"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "plugin.session-path-guard" })

// Mirrors session/reminders.ts sessionsDir() (canonical source: :128).
// Duplicated deliberately (2-line pure helper) to avoid importing the heavy
// reminders module graph (Session/Agent/MessageV2) into plugin init (DEC-4).
// Cross-reference: history.mjs guardSessionPathShape() uses the same shape
// vocabulary (DEC-6) — keep both in sync; tests pin fixtures on both sides.
const sessionsRoot = (): string =>
  process.env.AGENT_SESSIONS_DIR ?? path.join(os.homedir(), ".agent-sessions")

// Shape rule mirrors history.mjs guardSessionPathShape (`\d\d-\d\d-\d\d`);
// no calendar validation — deliberate symmetry (DEC-5): `99-99-99` normalizes too.
const FLAT_SEGMENT = /^(\d{2})-(\d{2})-(\d{2})(?=\/|$)/

/** Pure, exported for unit tests. Returns corrected path or undefined when no rewrite applies. */
export function normalizeSessionPathShape(
  target: string,
  root = sessionsRoot(),
): string | undefined {
  // Normalize the comparison form once: absolute inputs stay byte-stable;
  // relative inputs under the root get resolved (output becomes absolute — only
  // ever an upgrade, since write/edit require absolute paths anyway).
  const candidates = [target, path.resolve(target)]
  for (const cand of candidates) {
    for (const base of [root, "~/.agent-sessions"]) {
      if (!cand.startsWith(base + "/")) continue
      const rest = cand.slice(base.length + 1)
      const m = FLAT_SEGMENT.exec(rest)
      if (m) return `${base}/${m[1]}/${m[2]}/${m[3]}${rest.slice(m[0].length)}`
    }
  }
  return undefined
}

const GUARDED_TOOLS = new Set(["write", "edit", "read"])

export const SessionPathGuardPlugin: Plugin = async () => {
  log.info("session-path guard plugin initialized")
  return {
    "tool.execute.before": async (input, output) => {
      if (!GUARDED_TOOLS.has(input.tool)) return
      const args = output.args as Record<string, unknown> | undefined
      const key =
        typeof args?.filePath === "string" ? "filePath"
        : typeof args?.path === "string" ? "path"
        : undefined
      if (!args || !key) return
      const original = args[key] as string
      const corrected = normalizeSessionPathShape(original)
      if (!corrected) return
      args[key] = corrected // same object reaches item.execute
      log.warn(
        "RED FLAG — flat date form in session path, normalized to canonical shape",
        {
          tool: input.tool,
          sessionID: input.sessionID,
          from: original,
          to: corrected,
          note: "rendered output may show nested paths flat; trust these bytes, verify with find",
        },
      )
    },
  }
}

import path from "path"
import os from "os"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* AppFileSystem.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // C2 scaffold-verification reminder (D4: nudge-only). When the agent declares
  // `startupContract.scaffold: true`, verify the agent-sessions scaffold before
  // the assistant reply; while unmet, append a synthetic nudge to the last user
  // message. The check repeats each user turn until it passes and NEVER blocks
  // or aborts the turn — fs errors are folded into "unmet" (a nudge, still not
  // a block). Agents without the contract see zero behavior change.
  if (input.agent.startupContract?.scaffold) {
    const met = verifyScaffold({
      sessionID: input.session.id,
      sessionsDir: sessionsDir(),
      io: nodeIO(),
    })
    applyScaffoldReminder({ messages: input.messages, agent: input.agent, met })
  }

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

// --- C2 scaffold verification (pure, injectable; D4 nudge-only) ---

export const SCAFFOLD_NUDGE =
  "Startup contract not met: scaffold the session (folder + session.md + history record) before answering."

export interface ScaffoldIO {
  exists: (p: string) => boolean | undefined
  read: (p: string) => string | undefined
  readDir?: (p: string) => string[] | undefined
}

/**
 * Session-folder mechanism (design note):
 * The scaffold contract (session.md + history.jsonl) is a convention of the
 * agent-sessions scaffold — the scaffold's `session.md` carries a `sessionId:`
 * frontmatter field equal to the session id. Sessions live under
 * `AGENT_SESSIONS_DIR` (env, overridable) or `~/.agent-sessions` by default;
 * the folder itself is located by a depth-limited search for the `session.md`
 * whose frontmatter matches. This is what the scaffolded artifacts actually
 * satisfy; nothing here hardcodes a user's home.
 */
export const sessionsDir = (): string =>
  process.env.AGENT_SESSIONS_DIR ?? path.join(os.homedir(), ".agent-sessions")

export const nodeIO = (): ScaffoldIO => ({
  exists: (p) => {
    try {
      return require("node:fs").existsSync(p)
    } catch {
      return false
    }
  },
  read: (p) => {
    try {
      return require("node:fs").readFileSync(p, "utf8") as string | undefined
    } catch {
      return undefined
    }
  },
  readDir: (p) => {
    try {
      return require("node:fs").readdirSync(p) as string[]
    } catch {
      return undefined
    }
  },
})

const sessionIDFromFrontmatter = (text: string): string | undefined => {
  const match = text.match(/^sessionId:\s*(\S+)/m)
  return match?.[1]?.replace(/^["']|["']$/g, "")
}

const walkForSession = (io: ScaffoldIO, dir: string, sessionID: string, depth: number): string | undefined => {
  if (depth < 0) return undefined
  const md = path.join(dir, "session.md")
  if (io.exists(md) && sessionIDFromFrontmatter(io.read(md) ?? "") === sessionID) return dir
  const list = io.readDir?.(dir)
  for (const name of list ?? []) {
    const hit = walkForSession(io, path.join(dir, name), sessionID, depth - 1)
    if (hit) return hit
  }
  return undefined
}

/**
 * Pure scaffold verification: `session.md` exists with a matching
 * `sessionId:` frontmatter value AND `history.jsonl` has >= 1 record.
 * Injectable io lets tests use temp-dir fixtures instead of the real home.
 * Any io failure means "unmet" — it never throws.
 */
export const verifyScaffold = (input: { sessionID: string; sessionsDir: string; io: ScaffoldIO }): boolean => {
  try {
    const dir = walkForSession(input.io, input.sessionsDir, input.sessionID, 4)
    if (!dir) return false
    const history = input.io.read(path.join(dir, "history.jsonl"))
    if (!history) return false
    const records = history.split("\n").filter((line) => line.trim().length > 0)
    return records.length >= 1
  } catch {
    return false
  }
}

/**
 * Pure reminder application: when the agent declares
 * `startupContract.scaffold: true` and verification is unmet, append a
 * `synthetic: true` text nudge to the last user message (existing reminders
 * pattern). Met contract or missing contract → zero behavior change. Never
 * blocks or aborts the turn.
 */
export const applyScaffoldReminder = (input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  met: boolean
}): MessageV2.WithParts[] => {
  if (!input.agent.startupContract?.scaffold) return input.messages
  if (input.met) return input.messages
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages
  userMessage.parts.push({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: SCAFFOLD_NUDGE,
    synthetic: true,
  })
  return input.messages
}

export * as SessionReminders from "./reminders"

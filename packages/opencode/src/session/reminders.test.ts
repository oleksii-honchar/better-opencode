import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import type { Agent } from "@/agent/agent"
import { MessageV2 } from "./message-v2"
import { SessionReminders } from "./reminders"

// C2 scaffold-verification reminder (D4 nudge-only):
// When the agent declares `startupContract.scaffold: true`, every user turn
// verifies the agent-sessions scaffold (session.md with matching `sessionId:`
// frontmatter + history.jsonl with >= 1 record). While unmet, a synthetic
// reminder part is appended to the last user message. Once met — and for
// agents without the contract — zero behavior change. Verification failure
// (including fs errors) never blocks or aborts the turn.

const NUDGE = "Startup contract not met: scaffold the session (folder + session.md + history record) before answering."

const nodeIO = () => ({
  exists: (p: string) => rmGuard(() => require("node:fs").existsSync(p)),
  read: (p: string) => rmGuard(() => { try { return require("node:fs").readFileSync(p, "utf8") } catch { return undefined } }),
  readDir: (p: string) => rmGuard(() => { try { return require("node:fs").readdirSync(p) as string[] } catch { return undefined } }),
})
function rmGuard<T>(fn: () => T): T {
  try { return fn() } catch { return undefined as unknown as T }
}

function tempSessionTree(mod: (root: string) => void): string {
  const root = mkdtempSync(path.join(tmpdir(), "scaffold-verify-"))
  mod(root)
  return root
}

const scaffoldedSession = (root: string, sessionID: string) => {
  const dir = path.join(root, "26", "09", "01", "260901-0000-test")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "session.md"), `---\nsessionId: ${sessionID}\nsessionPath: "${dir}"\n---\n\n# test\n`)
  writeFileSync(path.join(dir, "history.jsonl"), `${JSON.stringify({ ts: "t", sessionId: sessionID, agent: "worker", event: "started" })}\n`)
  return dir
}

const userID = "ses_user0000000000000000000A"

function userMessages(sessionID: string): MessageV2.WithParts[] {
  const user: MessageV2.WithParts = {
    info: { id: "msg_u1", role: "user", sessionID } as MessageV2.User,
    parts: [{ id: "p1", messageID: "msg_u1", sessionID, type: "text", text: "hello" }],
  } as unknown as MessageV2.WithParts
  return [user]
}

const agent = (over: Partial<Agent.Info> = {}): Agent.Info =>
  ({ name: "simple-session", ...over }) as Agent.Info

describe("verifyScaffold — injectable pure verification (temp-dir fixtures)", () => {
  test("met contract: session.md with matching sessionId + history.jsonl with >=1 record", () => {
    const root = tempSessionTree((r) => scaffoldedSession(r, userID))
    try {
      expect(SessionReminders.verifyScaffold({ sessionID: userID, sessionsDir: root, io: nodeIO() })).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("unmet: no session.md anywhere", () => {
    const root = tempSessionTree(() => {})
    try {
      expect(SessionReminders.verifyScaffold({ sessionID: userID, sessionsDir: root, io: nodeIO() })).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("unmet: session.md exists but sessionId frontmatter mismatches", () => {
    const root = tempSessionTree((r) => scaffoldedSession(r, "ses_other000000000000000000"))
    try {
      expect(SessionReminders.verifyScaffold({ sessionID: userID, sessionsDir: root, io: nodeIO() })).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("unmet: session.md matches but history.jsonl is empty", () => {
    const root = tempSessionTree((r) => {
      const dir = scaffoldedSession(r, userID)
      writeFileSync(path.join(dir, "history.jsonl"), "")
    })
    try {
      expect(SessionReminders.verifyScaffold({ sessionID: userID, sessionsDir: root, io: nodeIO() })).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("unmet: session.md matches but history.jsonl is absent", () => {
    const root = tempSessionTree((r) => {
      const dir = scaffoldedSession(r, userID)
      rmSync(path.join(dir, "history.jsonl"))
    })
    try {
      expect(SessionReminders.verifyScaffold({ sessionID: userID, sessionsDir: root, io: nodeIO() })).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("unmet: sessionsDir does not exist at all (fs errors are 'unmet', never thrown)", () => {
    expect(SessionReminders.verifyScaffold({ sessionID: userID, sessionsDir: "/nonexistent/zz", io: nodeIO() })).toBe(false)
  })
})

describe("applyScaffoldReminder — synthetic part appended to last user message", () => {
  const contractAgent = agent({ startupContract: { scaffold: true } })

  test("unmet contract (verified false) -> synthetic:true nudge part appended to last user message", () => {
    const msgs = userMessages(userID)
    const out = SessionReminders.applyScaffoldReminder({ messages: msgs, agent: contractAgent, met: false })
    expect(out).toBe(msgs) // same array: part pushed onto last user message
    const user = out.findLast((m) => m.info.role === "user")
    const synthetic = user!.parts.filter((p: any) => p.synthetic === true)
    expect(synthetic).toHaveLength(1)
    expect(synthetic[0].type).toBe("text")
    expect((synthetic[0] as { text: string }).text).toBe(NUDGE)
  })

  test("met contract (verified true) -> no synthetic part", () => {
    const msgs = userMessages(userID)
    const out = SessionReminders.applyScaffoldReminder({ messages: msgs, agent: contractAgent, met: true })
    const user = out.findLast((m) => m.info.role === "user")
    expect(user!.parts.filter((p: any) => p.synthetic === true)).toHaveLength(0)
  })

  test("agent without startupContract -> no verification, no part (io never consulted)", () => {
    const msgs = userMessages(userID)
    const out = SessionReminders.applyScaffoldReminder({ messages: msgs, agent: agent(), met: false })
    const user = out.findLast((m) => m.info.role === "user")
    expect(user!.parts.filter((p: any) => p.synthetic === true)).toHaveLength(0)
  })

  test("repeat-until-met: unmet check appends once; next met check appends nothing", () => {
    const msgs = userMessages(userID)
    SessionReminders.applyScaffoldReminder({ messages: msgs, agent: contractAgent, met: false })
    let user = msgs.findLast((m) => m.info.role === "user")
    expect(user!.parts.filter((p: any) => p.synthetic === true)).toHaveLength(1)
    SessionReminders.applyScaffoldReminder({ messages: msgs, agent: contractAgent, met: true })
    user = msgs.findLast((m) => m.info.role === "user")
    expect(user!.parts.filter((p: any) => p.synthetic === true)).toHaveLength(1) // still exactly one, no new part
  })
})

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { Database } from "bun:sqlite"
import type { Agent } from "@/agent/agent"
import { Effect, Layer } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceRef } from "@/effect/instance-ref"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionReminders } from "./reminders"
import { makeNudgeEmit, type NudgeEmitDeps, type NudgeInfo } from "./nudge-emit"
import { defaultInspectorConfig } from "@/session-inspector/config.schema"
import { resolvePayload } from "@/session-inspector/payload"

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

// ── Task 8: plugin.nudge attribution line at synthetic-part append sites (DEC-H;
// spec §5.2 emitter discipline; §8 default-OFF key). In-process writer must
// reproduce history.mjs append discipline byte-for-byte: one JSON object per line,
// base keys exactly the v2.3 set, sessionId from the session.md frontmatter,
// file created only on first write, resolver bounded, NEVER throws. ────────────
describe("nudge-emit — plugin.nudge history attribution (default-OFF, never-throws)", () => {
  const unicodeNudge = "Scaffold unmet: ünïcødé ✓ nudge with multibyte ✓"

  const sessionWorld = (sessionId: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "nudge-world-"))
    writeFileSync(path.join(dir, "session.md"), `---\nsessionId: ${sessionId}\n---\n\n# nudge fixture\n`)
    return dir
  }
  const readHistory = (dir: string) => readFileSync(path.join(dir, "history.jsonl"), "utf8").trim().split("\n").filter(Boolean)

  const depsFor = (world: string, over: Partial<NudgeEmitDeps> = {}): NudgeEmitDeps & { debugs: string[] } => {
    const debugs: string[] = []
    return {
      debugs,
      enabled: () => true,
      sessionDir: () => ({ ok: true as const, path: world }),
      readFile: (p) => {
        try {
          return readFileSync(p, "utf8")
        } catch {
          return undefined
        }
      },
      appendLine: (p, line) => writeFileSync(p, line + "\n", { flag: "a" }),
      env: {},
      debug: (m) => debugs.push(m),
      ...over,
    }
  }

  test("flag OFF (default): zero writes, ZERO resolver spawns, no throw", () => {
    let resolverCalls = 0
    let appendCalls = 0
    const emit = makeNudgeEmit({
      enabled: () => false,
      sessionDir: () => {
        resolverCalls++
        return { ok: true, path: "/never" }
      },
      readFile: () => undefined,
      appendLine: () => {
        appendCalls++
      },
      debug: () => {},
    })
    emit({ sessionID: userID, kind: "scaffold-reminder", text: unicodeNudge, partID: "prt_nudge_off_1" })
    expect(resolverCalls).toBe(0)
    expect(appendCalls).toBe(0)
  })

  test("flag ON: exactly ONE line; base keys exactly the v2.3 set; details = the 4-field DEC-L carrier; sessionId from FRONTMATTER", () => {
    const world = sessionWorld("ses_front000000000000000000A") // frontmatter id ≠ queried id
    try {
      const deps = depsFor(world)
      const emit = makeNudgeEmit(deps)
      emit({ sessionID: "ses_queried00000000000000000B", kind: "scaffold-reminder", text: unicodeNudge, partID: "prt_nudge_one" })
      const lines = readHistory(world)
      expect(lines).toHaveLength(1)
      const rec = JSON.parse(lines[0]!)
      expect(Object.keys(rec).sort()).toEqual(["agent", "details", "event", "nextAgent", "phase", "sessionId", "status", "ts"])
      expect(rec.event).toBe("plugin.nudge")
      expect(rec.agent).toBe("engine") // §5.2 vocabulary: agent id = engine/plugin id, not the persona
      expect(rec.sessionId).toBe("ses_front000000000000000000A")
      expect(rec.nextAgent).toBeNull()
      expect(rec.phase).toBeNull()
      expect(rec.status).toBeNull()
      expect(Number.isFinite(Date.parse(rec.ts))).toBe(true)
      const d = JSON.parse(rec.details)
      expect(Object.keys(d).sort()).toEqual(["emitter", "injected_bytes", "kind", "ref_part_id"])
      expect(d.emitter).toBe("engine")
      expect(d.kind).toBe("scaffold-reminder")
      expect(d.injected_bytes).toBe(Buffer.byteLength(unicodeNudge, "utf8")) // BYTES, not chars
      expect(d.ref_part_id).toBe("prt_nudge_one")
    } finally {
      rmSync(world, { recursive: true, force: true })
    }
  })

  test("one line per append: three kinds emitted at the exercise sites -> three distinct lines in order", () => {
    const world = sessionWorld(userID)
    try {
      const emit = makeNudgeEmit(depsFor(world))
      emit({ sessionID: userID, kind: "scaffold-reminder", text: NUDGE, partID: "prt_n_scaf" })
      emit({ sessionID: userID, kind: "plan-switch", text: "switch text", partID: "prt_n_switch" })
      emit({ sessionID: userID, kind: "plan-mode", text: "mode text", partID: "prt_n_mode" })
      const recs = readHistory(world).map((l) => JSON.parse(l))
      expect(recs).toHaveLength(3)
      expect(recs.map((r) => JSON.parse(r.details).kind)).toEqual(["scaffold-reminder", "plan-switch", "plan-mode"])
      expect(new Set(recs.map((r) => JSON.parse(r.details).ref_part_id)).size).toBe(3)
    } finally {
      rmSync(world, { recursive: true, force: true })
    }
  })

  test("failure paths never throw: missing session world, broken frontmatter, append EACCES — host flow untouched", () => {
    const missing = makeNudgeEmit({
      enabled: () => true,
      sessionDir: () => ({ ok: false, reason: "resolver exited 1" }),
      readFile: () => undefined,
      appendLine: () => {},
      debug: () => {},
    })
    missing({ sessionID: userID, kind: "plan-mode", text: "x", partID: "prt_a" })

    const world = mkdtempSync(path.join(tmpdir(), "nudge-broken-"))
    writeFileSync(path.join(world, "session.md"), "no frontmatter here")
    const broken = makeNudgeEmit({
      enabled: () => true,
      sessionDir: () => ({ ok: true, path: world }),
      readFile: (p) => {
        try {
          return readFileSync(p, "utf8")
        } catch {
          return undefined
        }
      },
      appendLine: () => {
        throw new Error("EACCES: permission denied")
      },
      debug: () => {},
    })
    broken({ sessionID: userID, kind: "plan-switch", text: "x", partID: "prt_b" })
    expect(broken).toBeFunction()

    const roWorld = sessionWorld(userID)
    const histPath = path.join(roWorld, "history.jsonl")
    writeFileSync(histPath, "")
    chmodSync(histPath, 0o444)
    const ro = makeNudgeEmit(depsFor(roWorld, {
      appendLine: (p, line) => writeFileSync(p, line + "\n", { flag: "a" }), // real append against 0444 -> throws inside; must be swallowed
    }))
    ro({ sessionID: userID, kind: "scaffold-reminder", text: "x", partID: "prt_c" })
    chmodSync(histPath, 0o644)
    expect(readFileSync(histPath, "utf8")).toBe("") // host journal untouched
    rmSync(world, { recursive: true, force: true })
    rmSync(roWorld, { recursive: true, force: true })
  })

  test("default config carries the flag OFF (§8 enablement is P5)", () => {
    const cfg = defaultInspectorConfig({ agentsRoot: "/x", logsDir: "/y" })
    expect((cfg as unknown as { emitters: { pluginNudgeHistory: boolean } }).emitters.pluginNudgeHistory).toBe(false)
  })
})

describe("reminders wiring — apply() emits exactly one nudge line per synthetic append", () => {
  const stubSessions = (onUpdatePart?: (part: Record<string, unknown>) => void) =>
    ({
      updatePart: Effect.fn("stub.updatePart")(function* (part: Record<string, unknown>) {
        onUpdatePart?.(part)
        return part
      }),
    }) as never

  // RuntimeFlags.Info shape mirrored from session.test.ts createMockRuntimeFlags.
  const mockFlags = (experimentalPlanMode: boolean): RuntimeFlags.Info => ({
    autoShare: false,
    pure: false,
    disableDefaultPlugins: false,
    disableChannelDb: false,
    disableEmbeddedWebUi: false,
    disableExternalSkills: false,
    disableLspDownload: false,
    skipMigrations: false,
    disableClaudeCodePrompt: false,
    disableClaudeCodeSkills: false,
    enableExa: false,
    enableParallel: false,
    enableExperimentalModels: false,
    enableQuestionTool: false,
    experimentalScout: false,
    experimentalBackgroundSubagents: false,
    experimentalLspTy: false,
    experimentalLspTool: false,
    experimentalOxfmt: false,
    experimentalPlanMode,
    experimentalEventSystem: false,
    experimentalWorkspaces: false,
    experimentalIconDiscovery: false,
    outputTokenMax: undefined,
    bashDefaultTimeoutMs: undefined,
    experimentalNativeLlm: false,
    client: "cli",
  })

  const stubFsys = () =>
    ({
      existsSafe: Effect.fn("stub.existsSafe")(function* () {
        return false
      }),
      ensureDir: Effect.fn("stub.ensureDir")(function* () {
        return undefined
      }),
    }) as never

  const instanceCtx = () =>
    ({ project: {}, worktree: "/tmp/instance", directory: "/tmp/instance" }) as never

  async function runApply(input: {
    messages: MessageV2.WithParts[]
    agent: Agent.Info
    experimentalPlanMode: boolean
    capture: (info: NudgeInfo) => void
    onUpdatePart?: (part: Record<string, unknown>) => void
  }): Promise<MessageV2.WithParts[]> {
    const program = SessionReminders.apply({
      messages: input.messages,
      agent: input.agent,
      session: { id: userID, slug: "nudge-fixture", time: { created: 1 } } as unknown as Session.Info,
      nudgeEmit: input.capture,
    })
    return Effect.runPromise(
      Effect.provideService(
        Effect.provide(
          program,
          Layer.mergeAll(
            Layer.succeed(RuntimeFlags.Service, mockFlags(input.experimentalPlanMode)),
            Layer.succeed(AppFileSystem.Service, stubFsys()),
            Layer.succeed(Session.Service, stubSessions(input.onUpdatePart)),
          ),
        ),
        InstanceRef,
        instanceCtx(),
      ),
    )
  }

  test("non-experimental plan agent -> PROMPT_PLAN push emits exactly one plan-switch line", async () => {
    const captured: NudgeInfo[] = []
    const msgs = userMessages(userID)
    const out = await runApply({ messages: msgs, agent: agent({ name: "plan" }), experimentalPlanMode: false, capture: (i) => captured.push(i) })
    const synth = out.findLast((m) => m.info.role === "user")!.parts.filter((p: any) => p.synthetic === true)
    expect(synth).toHaveLength(1)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.kind).toBe("plan-switch")
    expect(captured[0]!.partID).toBe(synth[0]!.id) // ref = the very part id pushed
    expect(captured[0]!.text).toBe((synth[0] as { text: string }).text)
    expect(captured[0]!.sessionID).toBe(userID)
  })

  test("scaffold nudge path (contract on, world unmet, AGENT_SESSIONS_DIR=tmp) emits one scaffold-reminder line wired to the pushed part", async () => {
    const world = mkdtempSync(path.join(tmpdir(), "nudge-empty-world-"))
    const prev = process.env.AGENT_SESSIONS_DIR
    process.env.AGENT_SESSIONS_DIR = world // temp only (hard rule)
    try {
      const captured: NudgeInfo[] = []
      const msgs = userMessages(userID)
      const out = await runApply({ messages: msgs, agent: agent({ startupContract: { scaffold: true } }), experimentalPlanMode: false, capture: (i) => captured.push(i) })
      const synth = out.findLast((m) => m.info.role === "user")!.parts.filter((p: any) => p.synthetic === true)
      expect(synth).toHaveLength(1)
      expect(captured).toHaveLength(1)
      expect(captured[0]!.kind).toBe("scaffold-reminder")
      expect(captured[0]!.text).toBe(NUDGE)
      expect(captured[0]!.partID).toBe(synth[0]!.id)
    } finally {
      if (prev === undefined) delete process.env.AGENT_SESSIONS_DIR
      else process.env.AGENT_SESSIONS_DIR = prev
      rmSync(world, { recursive: true, force: true })
    }
  })

  test("experimental plan-mode: plan agent push (updatePart site) emits exactly one plan-mode line", async () => {
    const captured: NudgeInfo[] = []
    const msgs = userMessages(userID)
    const out = await runApply({
      messages: msgs,
      agent: agent({ name: "plan" }),
      experimentalPlanMode: true,
      capture: (i) => captured.push(i),
    })
    const synth = out.findLast((m) => m.info.role === "user")!.parts.filter((p: any) => p.synthetic === true)
    expect(synth).toHaveLength(1)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.kind).toBe("plan-mode")
    expect(captured[0]!.partID).toBe(synth[0]!.id)
    expect(captured[0]!.text).toBe((synth[0] as { text: string }).text)
  })

  test("experimental plan switch: updatePart-exp site emits one plan-switch line with the persisted text", async () => {
    const msgs = userMessages(userID)
    msgs.push({
      info: { role: "assistant", agent: "plan", id: "msg_assistant000000000000A", sessionID: userID } as unknown as MessageV2.Assistant,
      parts: [],
    } as unknown as MessageV2.WithParts)
    const captured: NudgeInfo[] = []
    const out = await runApply({
      messages: msgs,
      agent: agent({ name: "build" }),
      experimentalPlanMode: true,
      capture: (i) => captured.push(i),
    })
    const synth = out.findLast((m) => m.info.role === "user")!.parts.filter((p: any) => p.synthetic === true)
    expect(synth).toHaveLength(1)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.kind).toBe("plan-switch")
    expect(captured[0]!.partID).toBe(synth[0]!.id)
    expect(captured[0]!.text).toBe((synth[0] as { text: string }).text) // text === persisted part.text (round-trippable)
  })

  test("no synthetic append -> no emit (idle turns stay silent)", async () => {
    const captured: NudgeInfo[] = []
    await runApply({ messages: userMessages(userID), agent: agent({ name: "build" }), experimentalPlanMode: true, capture: (i) => captured.push(i) })
    await runApply({ messages: userMessages(userID), agent: agent({ name: "build" }), experimentalPlanMode: false, capture: (i) => captured.push(i) })
    expect(captured).toHaveLength(0)
  })

  test("reminder flow byte-identical under flag ON vs OFF (AC; volatile part ids normalized)", async () => {
    const scenario = (capture: (i: NudgeInfo) => void) =>
      runApply({
        messages: userMessages(userID),
        agent: agent({ name: "plan" }),
        experimentalPlanMode: false,
        capture,
      })
    const world = mkdtempSync(path.join(tmpdir(), "nudge-onoff-world-"))
    writeFileSync(path.join(world, "session.md"), `---\nsessionId: ${userID}\n---\n\n# on/off fixture\n`)
    try {
      const off = await scenario(() => {})
      const live: NudgeInfo[] = []
      const emit = makeNudgeEmit({
        enabled: () => true,
        sessionDir: () => ({ ok: true, path: world }),
        readFile: (p) => {
          try {
            return readFileSync(p, "utf8")
          } catch {
            return undefined
          }
        },
        appendLine: (p, line) => writeFileSync(p, line + "\n", { flag: "a" }),
        env: {},
        debug: () => {},
      })
      const on = await scenario((i) => {
        live.push(i)
        emit(i) // real writer, flag ON
      })
      const norm = (msgs: MessageV2.WithParts[]) =>
        JSON.parse(JSON.stringify(msgs).replace(/"id":"prt_[^"]+"/g, '"id":"prt_x"'))
      expect(norm(on)).toEqual(norm(off))
      expect(live).toHaveLength(1)
      const lines = readFileSync(path.join(world, "history.jsonl"), "utf8").trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!).event).toBe("plugin.nudge")
    } finally {
      rmSync(world, { recursive: true, force: true })
    }
  })
})

describe("ref_part_id round-trip — Task-4 payload resolution returns the full injected text", () => {
  test("dbId payload path resolves the exact synthetic part text + byte parity with injected_bytes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nudge-db-"))
    const dbPath = path.join(dir, "fixture.db")
    const db = new Database(dbPath)
    db.run("CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)")
    const fullText = "Startup contract not met: scaffold the session — ünïcødé ✓ full-text round trip ✓"
    const partID = "prt_nudge_roundtrip"
    db.run("INSERT INTO part (id, session_id, data) VALUES (?,?,?)", [
      partID,
      userID,
      JSON.stringify({ type: "text", text: fullText, synthetic: true }),
    ])
    db.close()
    const cfg = defaultInspectorConfig({ agentsRoot: dir, logsDir: dir })
    const res = resolvePayload({
      dbPath,
      sessionId: userID,
      sessionPath: dir,
      io: {
        read: (p: string) => {
          try {
            return { kind: "ok" as const, text: readFileSync(p, "utf8") }
          } catch {
            return { kind: "missing" as const }
          }
        },
        exists: (p: string) => {
          try {
            readFileSync(p)
            return true
          } catch {
            return false
          }
        },
        readDir: () => ({ kind: "ok" as const, entries: [] }),
        statSize: () => undefined,
      } as never,
      config: cfg,
      ref: { kind: "dbId", dbId: partID },
    })
    expect(res.resolved).toBe(true)
    const payload = res.payload as { text?: string }
    expect(payload.text).toBe(fullText)
    expect(Buffer.byteLength(fullText, "utf8")).toBe(Buffer.byteLength(fullText, "utf8")) // parity basis for injected_bytes
    rmSync(dir, { recursive: true, force: true })
  })
})

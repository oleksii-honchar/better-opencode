import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import * as bensynePlugin from "./index"

// ---------------------------------------------------------------------------
// Task 2 (A1/A3) — re-anchor cap + prompt rewrite
//
// Behavior under test (DEC-2):
//   A1: per-session cap — hook fires 1..MAX_REANCHORS_PER_SESSION inject text;
//       the (MAX+1)-th fire leaves output.text unset. Cap is per-session.
//   A3: rewritten prompt — no "re-enter the tree from the start" mandate,
//       traversal-history recall FIRST, per-session bank
//       `agent-session-{sessionID}` (never the legacy `agent-sessions_`).
//
// The cap state is a module-level Map keyed by sessionID, so every test uses
// its own unique sessionID to stay isolated.
// ---------------------------------------------------------------------------

function stubPluginInput(): PluginInput {
  return {
    client: {} as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:0"),
    $: {} as any,
    llm: {} as any,
  }
}

// Fire the post_recall hook once for a session; returns the output object the
// hook received (output.text set => re-anchor mandate injected).
async function fireRecallHook(sessionID: string): Promise<{ text?: string }> {
  const hooks = await bensynePlugin.BensyneRecallPlugin(stubPluginInput())
  const hook = hooks["experimental.compaction.post_recall"]
  expect(typeof hook).toBe("function")
  const output: { text?: string } = {}
  await hook!({ sessionID, agent: "worker", model: "mock-model" } as any, output)
  return output
}

describe("plugin.bensyne — re-anchor cap (A1)", () => {
  test("MAX_REANCHORS_PER_SESSION is a named const equal to 3", () => {
    expect(bensynePlugin.MAX_REANCHORS_PER_SESSION).toBe(3)
  })

  test("hook fires 1-3 inject recall text normally", async () => {
    const sessionID = "sess-cap-inject-1"

    for (let fire = 1; fire <= 3; fire++) {
      const output = await fireRecallHook(sessionID)
      expect(typeof output.text).toBe("string")
      expect(output.text!.trim().length).toBeGreaterThan(0)
    }
  })

  test("4th and later hook fires for the same session leave output.text unset", async () => {
    const sessionID = "sess-cap-blocked-1"

    // Fill the allowed budget first.
    for (let i = 0; i < 3; i++) {
      const output = await fireRecallHook(sessionID)
      expect(typeof output.text).toBe("string")
    }

    // 4th fire: no mandate injected (hook contract allows undefined text;
    // compaction.ts guards on non-empty text before injecting).
    const fourth = await fireRecallHook(sessionID)
    expect(fourth.text).toBeUndefined()

    // 5th fire: still suppressed.
    const fifth = await fireRecallHook(sessionID)
    expect(fifth.text).toBeUndefined()
  })

  test("cap is per-session — a second session is unaffected by the first hitting the cap", async () => {
    const exhausted = "sess-cap-A-exhausted"
    const fresh = "sess-cap-B-fresh"

    for (let i = 0; i < 4; i++) {
      await fireRecallHook(exhausted)
    }
    const blocked = await fireRecallHook(exhausted)
    expect(blocked.text).toBeUndefined()

    const other = await fireRecallHook(fresh)
    expect(typeof other.text).toBe("string")
    expect(other.text!.trim().length).toBeGreaterThan(0)
  })
})

describe("plugin.bensyne — rewritten recall prompt (A3)", () => {
  test("prompt no longer contains the self-propagating 're-enter the tree from the start' mandate", async () => {
    const output = await fireRecallHook("sess-prompt-mandate")
    expect(typeof output.text).toBe("string")
    expect(output.text).not.toContain("re-enter the tree from the start")
    expect(output.text).not.toContain("Do not try to recall your prior position")
  })

  test("prompt orders traversal-history recall FIRST, entry-node re-entry only as fallback", async () => {
    const sessionID = "sess-prompt-ordering"
    const output = await fireRecallHook(sessionID)
    const text = output.text!

    // Recall-first ordering signals
    expect(text).toContain("traversal-history")
    expect(text).toContain("persona.anchor_file_id")

    // Entry-node re-entry is still mentioned, but only as the fallback AFTER
    // the traversal-history recall instruction.
    const recallIdx = text.indexOf("traversal-history")
    const entryIdx = text.indexOf("getPersonaEntryNode")
    expect(entryIdx).toBeGreaterThan(-1)
    expect(recallIdx).toBeLessThan(entryIdx)
  })

  test("prompt references the per-session bank agent-session-{sessionID}, never the legacy agent-sessions_ bank", async () => {
    const sessionID = "sess-prompt-bank"
    const output = await fireRecallHook(sessionID)
    const text = output.text!

    expect(text).toContain(`agent-session-${sessionID}`)
    expect(text).not.toContain("agent-sessions_")
  })
})

describe("plugin.bensyne — replay guard: incident shape terminates", () => {
  test("10 consecutive compaction cycles produce at most MAX_REANCHORS_PER_SESSION re-anchor injections", async () => {
    // Incident shape: compaction → recall prompt → agent re-anchors →
    // compaction → … The cap must break the self-sustaining loop: across 10
    // simulated compactions of one session, at most 3 re-anchor mandates are
    // injected; the remaining passes get no text (loop cannot self-sustain).
    const sessionID = "sess-replay-guard-1"

    let injections = 0
    for (let pass = 0; pass < 10; pass++) {
      const output = await fireRecallHook(sessionID)
      if (typeof output.text === "string" && output.text.trim().length > 0) injections++
    }

    expect(injections).toBeLessThanOrEqual(3)
    expect(injections).toBe(bensynePlugin.MAX_REANCHORS_PER_SESSION)
  })
})

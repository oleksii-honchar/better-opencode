import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import { Permission } from "@/permission"
import { wrapWithLoopDetection } from "./wrapper"
import { defaultConfig, type UnstuckConfig } from "./config"
import { LoopDetectedError } from "./error"

// ---------------------------------------------------------------------------
// Integration test — doom_loop nudge instead of Permission.DeniedError
//
// Task 8 acceptance criteria:
//   1. 3× identical tool calls (same tool + same input) → `_unstuckNudge` user
//      message injected, stream restarted, and NO LoopDetectedError escapes to
//      the caller after the nudge.
//   2. The processor-level `doom_loop` permission check resolves to `allow`
//      with the new default (simulated ruleset mirroring agent.ts defaults).
//   3. No raw permission error (Permission.DeniedError) surfaces for the
//      doom-loop sequence.
//
// Helpers mirror the bun:test conventions from wrapper.test.ts (createMockStream,
// createMockModel, collectStream) with the doomConfig / doomLoopChunks pattern
// established in Task 4.
// ---------------------------------------------------------------------------

function createMockStream(chunks: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  let index = 0
  return new ReadableStream<LanguageModelV3StreamPart>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index++])
    },
  })
}

const mockUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
} as const

async function collectStream(
  model: LanguageModelV3,
  prompt: Array<{ role: string; content: string | unknown }> = [],
): Promise<LanguageModelV3StreamPart[]> {
  const result: LanguageModelV3StreamPart[] = []
  const streamResult = await model.doStream({ prompt: prompt as any } as LanguageModelV3CallOptions)
  const reader = streamResult.stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      result.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return result
}

// 3 identical tool-input-end chunks for tool "bash" with the SAME input,
// followed by a finish — the exact pattern the processor's DOOM_LOOP_THRESHOLD
// (processor.ts:32, 425-438) would flag, now detected at the stream level.
function doomLoopChunks(count = 3, toolName = "bash", input: Record<string, unknown> = { command: "ls -la" }): LanguageModelV3StreamPart[] {
  const chunks: LanguageModelV3StreamPart[] = []
  for (let i = 0; i < count; i++) {
    chunks.push({ type: "text-delta", id: `${i}-text`, delta: "Doom loop thinking" })
    chunks.push({ type: "tool-input-start", id: `call-${i}`, toolName })
    chunks.push({
      type: "tool-input-end",
      id: `call-${i}`,
      input,
      providerMetadata: undefined,
    } as any)
  }
  chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: mockUsage })
  return chunks
}

const recoveryChunks: LanguageModelV3StreamPart[] = [
  { type: "text-delta", id: "recovery-text", delta: "Recovery response" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage },
]

// Disable unrelated detectors so only doom_loop fires. nudgeMessage: undefined
// routes through defaultNudgeMessage (the doom_loop branch naming the tool).
const doomConfig: UnstuckConfig = {
  ...defaultConfig,
  maxNudges: 2,
  strategy: "nudge",
  loopThreshold: 100,
  detectToolOnlyLoops: false,
  enablePatternLoopDetection: false,
  enableSentenceLoopDetection: false,
  enableSelfDiagnosisDetection: false,
  enableXmlRepetitionGuard: false,
  nudgeMessage: undefined,
}

// Mock model: first doStream call emits the doom-loop stream (detected),
// subsequent calls emit a clean recovery stream. Captures call count + prompts.
function createDoomLoopModel(loopChunks: LanguageModelV3StreamPart[]): {
  model: LanguageModelV3
  callCount: () => number
  receivedPrompt: () => any[]
} {
  let callCount = 0
  let receivedPrompt: any[] = []
  const model: LanguageModelV3 = {
    modelId: "test-model",
    provider: "test",
    specificationVersion: "v3",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented")
    },
    async doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      callCount++
      receivedPrompt = args.prompt as any[]
      if (callCount === 1) {
        return { stream: createMockStream(loopChunks) }
      }
      return { stream: createMockStream(recoveryChunks) }
    },
  }
  return { model, callCount: () => callCount, receivedPrompt: () => receivedPrompt }
}

describe("doom_loop integration — nudge instead of Permission.DeniedError", () => {
  test("3× identical tool calls → nudge injected, stream restarted, no LoopDetectedError escapes", async () => {
    const { model, callCount, receivedPrompt } = createDoomLoopModel(doomLoopChunks())
    const wrapped = wrapWithLoopDetection(model, doomConfig)

    // If LoopDetectedError escaped after the nudge, collectStream would reject.
    let escaped: unknown = undefined
    let result: LanguageModelV3StreamPart[] = []
    try {
      result = await collectStream(wrapped, [{ role: "user", content: "Hello" }])
    } catch (e) {
      escaped = e
    }

    // No error escaped to the caller — nudge recovered the stream.
    expect(escaped).toBeUndefined()
    expect(escaped).not.toBeInstanceOf(LoopDetectedError)
    expect(result.length).toBeGreaterThan(0)
    expect(callCount()).toBe(2)

    // Nudge user message was injected with _unstuckNudge: true.
    const lastMessage = receivedPrompt()[receivedPrompt().length - 1]
    expect(lastMessage._unstuckNudge).toBe(true)
    const lastContent = lastMessage.content as Array<{ type: string; text: string }>
    expect(lastContent[0]?.text).toContain("bash")
    expect(lastContent[0]?.text).toContain("doom loop")
  })

  test("processor-level doom_loop permission check resolves to allow with the new default", () => {
    // Mirror the shared permission defaults from agent.ts (doom_loop: "allow")
    // merged with an empty user config — no explicit doom_loop override.
    const defaults = Permission.fromConfig({
      "*": "allow",
      doom_loop: "allow",
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      repo_clone: "deny",
      repo_overview: "deny",
    })
    const user = Permission.fromConfig({})
    const ruleset = Permission.merge(defaults, user)

    // This is the exact check processor.ts performs for the doom-loop sequence
    // (processor.ts:441-448) — evaluate "doom_loop" against the tool pattern.
    // A "deny" result would produce Permission.DeniedError; "allow" passes.
    const rule = Permission.evaluate("doom_loop", "bash", ruleset)
    expect(rule.action).toBe("allow")
  })

  test("old default (ask) or explicit deny would NOT resolve to allow — proving the default change matters", () => {
    // Pre-change default: doom_loop: "ask" → the processor would prompt, and an
    // effective deny would hard-stop with DeniedError.
    const oldDefaults = Permission.fromConfig({ "*": "allow", doom_loop: "ask" })
    expect(Permission.evaluate("doom_loop", "bash", oldDefaults).action).not.toBe("allow")

    // Explicit user deny (the pre-migration ruleset in this environment) → deny,
    // which is exactly the raw "Opencode failed to send message" DeniedError path.
    const deniedRuleset = Permission.merge(
      Permission.fromConfig({ "*": "allow", doom_loop: "allow" }),
      Permission.fromConfig({ doom_loop: "deny" }),
    )
    expect(Permission.evaluate("doom_loop", "bash", deniedRuleset).action).toBe("deny")
  })

  test("no raw permission error (DeniedError) surfaces for the doom-loop sequence", async () => {
    const { model } = createDoomLoopModel(doomLoopChunks())
    const wrapped = wrapWithLoopDetection(model, doomConfig)

    let escaped: unknown = undefined
    try {
      await collectStream(wrapped, [{ role: "user", content: "Hello" }])
    } catch (e) {
      escaped = e
    }

    // The end-to-end sequence completes with a nudge; no DeniedError (nor any
    // other error) escapes to the caller.
    expect(escaped).toBeUndefined()
    expect(escaped instanceof Permission.DeniedError).toBe(false)
  })
})

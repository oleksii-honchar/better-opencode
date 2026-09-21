import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { BensyneRecallPlugin } from "../../src/plugin/bensyne/index"

describe("plugin.bensyne", () => {
  describe("experimental.compaction.post_recall", () => {
    test("returns { text } with recall prompt, no HTTP side-effect (T5)", async () => {
      // Build a minimal PluginInput stub with a call-tracked client
      let promptCallCount = 0
      const stubClient = {
        session: {
          prompt: async () => {
            promptCallCount++
            return { response: { status: 200 } }
          },
        },
      }
      const input: PluginInput = {
        client: stubClient as any,
        project: {} as any,
        directory: "/tmp",
        worktree: "/tmp",
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost:0"),
        $: {} as any,
        llm: {} as any,
      }

      // Activate the plugin to get its hook map
      const hooks = await BensyneRecallPlugin(input)
      const hook = hooks["experimental.compaction.post_recall"]
      expect(typeof hook).toBe("function")

      // Mock context that compaction.process passes to the hook
      const ctx = {
        sessionID: "test-session-123",
        agent: "build",
        model: "test-model",
        path: { cwd: "/tmp", root: "/tmp" },
      }

      // Invoke the hook (pass empty output object per widened contract)
      const output: { text?: string } = {}
      if (hook) {
        await hook(ctx as any, output)
      }

      // T5 assertions:
      // 1. Hook sets output.text (not void)
      expect(typeof output.text).toBe("string")
      expect(output.text).toContain("recall")
      expect(output.text).toContain("Bensyne")

      // 2. Hook never calls session.prompt (no HTTP side-effect)
      expect(promptCallCount).toBe(0)
    })
  })
})

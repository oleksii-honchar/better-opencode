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
        serverPort: 0,
        serverUrl: "http://localhost:0",
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

      // Invoke the hook
      const result = await hook(ctx as any)

      // T5 assertions:
      // 1. Hook returns { text } shape (not void)
      expect(typeof result).toBe("object")
      expect(result).not.toBeNull()
      expect(typeof result.text).toBe("string")
      expect(result.text).toContain("recall")
      expect(result.text).toContain("Bensyne")

      // 2. Hook never calls session.prompt (no HTTP side-effect)
      expect(promptCallCount).toBe(0)
    })
  })
})

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "plugin.bensyne-recall" })

/**
 * Bensyne Recall Plugin
 *
 * Listens for the post-compaction recall hook and returns a { text }
 * prompt that compaction.process injects as a synthetic user message,
 * asking the agent to recall its traversal history from the Bensyne
 * memory system.
 *
 * This ensures that after compaction (when the context window is
 * summarized and the agent loses its position awareness), the agent
 * immediately restores its memory of which decision node it's at.
 *
 * Hook contract (experimental.compaction.post_recall):
 *   input:  { sessionID, agent, model, path }
 *   output: { text } or undefined
 *   side effects: none (in-process injection only, no HTTP)
 */
export const BensyneRecallPlugin: Plugin = async (input: PluginInput) => {
  log.info("Bensyne recall plugin initialized")

  return {
    "experimental.compaction.post_recall": async (ctx, output) => {
      log.info("Bensyne: post-compaction recall hook triggered", {
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        model: ctx.model,
      })

      const recallPrompt =
        "Please recall your current position in the decision tree by checking your traversal history in the Bensyne memory system (call recallMemory with category=traversal-history and relevant context)."

      log.info("Bensyne: recall queued (in-process injection)", {
        sessionID: ctx.sessionID,
        promptLength: recallPrompt.length,
      })

      output.text = recallPrompt
    },
  }
}
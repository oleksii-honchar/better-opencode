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

      const recallPrompt = `Your session context was just compacted. To re-anchor in your persona decision tree: meta_search("getPersonaEntryNode") → meta_use("getPersonaEntryNode", { memory_bank: "your-persona-bank" }) to find the entry node, then traverse forward. Also recall your recent context from the current session bank — meta_search("recall") → meta_use("recall", { query: "<current task>", memory_bank: "agent-sessions_${ctx.sessionID}", limit: 5 }). Do not try to recall your prior position — re-enter the tree from the start. Before proceeding, state your current node and the status of its target, veto, and conditions for traversal.`

      log.info("Bensyne: recall queued (in-process injection)", {
        sessionID: ctx.sessionID,
        promptLength: recallPrompt.length,
      })

      output.text = recallPrompt
    },
  }
}

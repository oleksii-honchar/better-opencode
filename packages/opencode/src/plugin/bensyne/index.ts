import type { Plugin, PluginInput } from "@opencode-ai/plugin"

/**
 * Bensyne Recall Plugin
 *
 * Listens for the post-compaction recall hook and injects a synthetic
 * user message asking the agent to recall its traversal history from
 * the Bensyne memory system.
 *
 * This ensures that after compaction (when the context window is
 * summarized and the agent loses its position awareness), the agent
 * immediately restores its memory of which decision node it's at.
 */
export const BensyneRecallPlugin: Plugin = async (input: PluginInput) => {
  const { client, log } = input

  log.info("Bensyne recall plugin initialized")

  return {
    "experimental.compaction.post_recall": async (ctx) => {
      log.info("Bensyne: post-compaction recall hook triggered", {
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        model: ctx.model,
      })

      try {
        // Send a synthetic user message asking the agent to recall
        // its traversal history from the Bensyne memory system.
        // The agent will call the Bensyne recallMemory MCP tool as
        // part of its normal operation.
        const recallPrompt =
          "Please recall your current position in the decision tree by checking your traversal history in the Bensyne memory system (call recallMemory with category=traversal-history and relevant context)."

        log.debug("Bensyne: sending recall prompt", {
          sessionID: ctx.sessionID,
          promptLength: recallPrompt.length,
        })

        const response = await client.session.prompt({
          path: { id: ctx.sessionID },
          body: {
            parts: [
              {
                type: "text",
                text: recallPrompt,
                synthetic: true,
              },
            ],
          },
        })

        log.info("Bensyne: recall prompt sent successfully", {
          sessionID: ctx.sessionID,
          responseStatus: response?.status ?? "unknown",
        })
      } catch (err) {
        log.warn("Bensyne: post-compaction recall failed", {
          sessionID: ctx.sessionID,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })
      }
    },
  }
}
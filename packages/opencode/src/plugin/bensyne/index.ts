import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "plugin.bensyne-recall" })

/**
 * Per-session cap on post-compaction re-anchor injections (DEC-2).
 * The 2026-10-03 incident showed the recall mandate can self-sustain a
 * compaction↔re-anchor doom-loop (727 injections). After this many injected
 * mandates for one session, the hook stops setting output.text — the session
 * still gets the compaction summary and autocontinue; only the re-anchor
 * mandate stops.
 */
export const MAX_REANCHORS_PER_SESSION = 3

// Module-level per-session fire counter, keyed by ctx.sessionID.
// In-process only — resets with the process, which is acceptable: the cap
// bounds runaway loops within a run, not across restarts.
const reanchorState = new Map<string, { count: number }>()

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

      // A1: per-session re-anchor cap. Count this fire; past the cap, return
      // without setting output.text (hook contract allows undefined text;
      // compaction.ts only injects non-empty text).
      const state = reanchorState.get(ctx.sessionID) ?? { count: 0 }
      state.count += 1
      reanchorState.set(ctx.sessionID, state)
      if (state.count > MAX_REANCHORS_PER_SESSION) {
        log.info("bensyne: re-anchor cap reached", {
          sessionID: ctx.sessionID,
          count: state.count,
        })
        return
      }

      // A3: recall-first ordering — resume at the recorded traversal position
      // (traversal-history memories + persona.anchor_file_id); re-enter the
      // entry node ONLY when recall finds no traversal history. The former
      // "Do not try to recall your prior position — re-enter the tree from
      // the start." mandate is deleted: the compaction LLM copied it into
      // goal summaries and self-propagated it (E9). The bank reference is the
      // per-session bank `agent-session-{sessionID}` — the legacy
      // `agent-sessions_${sessionID}` name was deleted 2026-08-29.
      const recallPrompt = `Your session context was just compacted. To re-anchor in your persona decision tree, FIRST recall your traversal history: meta_search("recall") → meta_use("recall", { query: "traversal-history", memory_bank: "agent-session-${ctx.sessionID}", limit: 5 }) and read the persona.anchor_file_id session metadata; resume at that node. ONLY if recall yields no traversal history: meta_search("getPersonaEntryNode") → meta_use("getPersonaEntryNode", { memory_bank: "your-persona-bank" }) to find the entry node, then traverse forward. Before proceeding, state your current node and the status of its target, veto, and conditions for traversal.`

      log.info("Bensyne: recall queued (in-process injection)", {
        sessionID: ctx.sessionID,
        promptLength: recallPrompt.length,
      })

      output.text = recallPrompt
    },
  }
}

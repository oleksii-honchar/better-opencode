import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import * as Log from "@opencode-ai/core/util/log"
import type { UnstuckConfig } from "./config"
import { LoopDetectedError, type LoopDetectedInfo } from "./error"
import type { LoopDetector } from "./loop-detector"

const log = Log.create({ service: "unstuck" })

type Message = {
  role: "user" | "assistant" | "system" | "tool"
  content: unknown
  [key: string]: unknown
}

type DoStreamArgs = {
  messages: Message[]
  [key: string]: unknown
}

function defaultNudgeMessage(info: LoopDetectedInfo): string {
  if (info.type === "sentence_loop") {
    return `You are repeating the sentence "${info.sentence}" — this is a loop. Break out and take a different direction.`
  }
  return "You appear to be stuck in a loop — repeating the same thinking or tool calls. Break out of the pattern and take a different direction."
}

function pruneLoopingMessages(
  messages: Message[],
  pruneCount: number,
): Message[] {
  const assistantIndices: number[] = []

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      assistantIndices.push(i)
    }
  }

  const toRemove = Math.min(pruneCount, assistantIndices.length)
  const indicesToRemove = new Set(assistantIndices.slice(-toRemove))

  return messages.filter((_, i) => !indicesToRemove.has(i))
}

function mapStreamChunk(chunk: LanguageModelV3StreamPart): unknown {
  // Map the AI SDK stream part to our StreamChunk type
  switch (chunk.type) {
    case "reasoning": {
      if (chunk.textDelta !== undefined) {
        return { type: "reasoning-delta" as const, text: chunk.textDelta }
      }
      return undefined
    }
    case "text-delta": {
      return { type: "text-delta" as const, text: chunk.textDelta }
    }
    case "tool-input-start": {
      return {
        type: "tool-input-start" as const,
        id: chunk.toolCallId,
        toolName: chunk.toolName,
        providerExecuted: chunk.providerExecuted ?? false,
      }
    }
    case "tool-input-delta": {
      return { type: "tool-input-delta" as const, id: chunk.toolCallId, text: chunk.textDelta }
    }
    case "tool-input-end": {
      return {
        type: "tool-input-end" as const,
        id: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input ?? {},
        providerExecuted: chunk.providerExecuted ?? false,
      }
    }
    case "step-start":
    case "step-finish": {
      return { type: "finish-step" as const, isCompaction: false }
    }
    case "finish": {
      return { type: "finish" as const, finishReason: chunk.finishReason }
    }
    default:
      return undefined
  }
}

async function* streamWithDetection(
  model: LanguageModelV3,
  detector: LoopDetector,
  config: UnstuckConfig,
  args: DoStreamArgs,
): AsyncGenerator<LanguageModelV3StreamPart, void, unknown> {
  const originalStream = model.doStream(args)

  for await (const chunk of originalStream) {
    const mappedChunk = mapStreamChunk(chunk)
    if (mappedChunk) {
      const loopInfo = detector.consumeChunk(mappedChunk, config)
      if (loopInfo) {
        throw new LoopDetectedError(loopInfo)
      }
    }
    yield chunk
  }
}

export function wrapWithLoopDetection(
  model: LanguageModelV3,
  detector: LoopDetector,
  config: UnstuckConfig,
): LanguageModelV3 {
  let nudgeCount = 0

  const wrapped: LanguageModelV3 = {
    ...model,
    async *doStream(args: DoStreamArgs): AsyncGenerator<LanguageModelV3StreamPart, void, unknown> {
      if (!config.enabled) {
        yield* model.doStream(args)
        return
      }

      try {
        yield* streamWithDetection(model, detector, config, args)
      } catch (error) {
        if (!(error instanceof LoopDetectedError)) throw error

        // --- Warn mode: log and rethrow ---
        if (config.strategy === "warn") {
          log.info("loop detected (warn mode)", { type: error.info.type, threshold: error.info.threshold })
          throw error
        }

        // --- Abort mode: log and rethrow ---
        if (config.strategy === "abort") {
          log.info("loop detected (abort mode)", { type: error.info.type, threshold: error.info.threshold })
          throw error
        }

        // --- Nudge-and-prune mode ---
        if (nudgeCount >= config.maxNudges) {
          log.warn("max nudges reached", { maxNudges: config.maxNudges, fallback: "abort" })
          throw error
        }

        nudgeCount++

        // Prune looping assistant messages
        const prunedMessages = pruneLoopingMessages(args.messages, config.pruneCount)

        // Inject nudge user message
        const nudgeMessage = config.nudgeMessage ?? defaultNudgeMessage(error.info)
        const nudgedMessages: Message[] = [
          ...prunedMessages,
          {
            role: "user",
            content: nudgeMessage,
            _unstuckNudge: true,
          },
        ]

        log.info("nudge applied", {
          nudgeCount,
          prunedMsgs: args.messages.length - prunedMessages.length,
          strategy: "nudge-and-prune",
        })

        // Reset detector state for the new attempt
        detector.reset()

        // Restart with modified messages — goes through loop detection again
        yield* streamWithDetection(model, detector, config, { ...args, messages: nudgedMessages })
      }
    },
  }

  return wrapped
}

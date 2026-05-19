import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import * as Log from "@opencode-ai/core/util/log"
import type { UnstuckConfig } from "./config"
import { LoopDetectedError, type LoopDetectedInfo } from "./error"
import type { LoopDetector, StreamChunk } from "./loop-detector"

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

function mapStreamChunk(chunk: LanguageModelV3StreamPart, currentToolName: string | undefined): StreamChunk | undefined {
  // Map the AI SDK LanguageModelV3StreamPart to our StreamChunk type
  // currentToolName tracks the tool name from tool-input-start to tool-input-end
  switch (chunk.type) {
    case "reasoning-delta": {
      return { type: "reasoning-delta" as const, text: chunk.delta }
    }
    case "text-delta": {
      return { type: "text-delta" as const, text: chunk.delta }
    }
    case "tool-input-start": {
      return {
        type: "tool-input-start" as const,
        id: chunk.id,
        toolName: chunk.toolName,
        providerExecuted: chunk.providerExecuted ?? false,
      }
    }
    case "tool-input-delta": {
      return { type: "tool-input-delta" as const, id: chunk.id, text: chunk.delta }
    }
    case "tool-input-end": {
      return {
        type: "tool-input-end" as const,
        id: chunk.id,
        toolName: currentToolName ?? (chunk as any).toolName ?? "unknown",
        input: (chunk as any).input ?? {},
        providerExecuted: (chunk as any).providerExecuted ?? false,
      }
    }
    case "finish": {
      return { type: "finish" as const, finishReason: chunk.finishReason.unified }
    }
    default:
      return undefined
  }
}

async function* streamWithDetection(
  model: LanguageModelV3,
  detector: LoopDetector,
  config: UnstuckConfig,
  args: LanguageModelV3CallOptions,
): AsyncGenerator<LanguageModelV3StreamPart, void, unknown> {
  // model.doStream returns Promise<LanguageModelV3StreamResult>.
  // We need to get the underlying async iterable. The LanguageModelV3StreamResult
  // only exposes pipeThrough(TransformStream) -> ReadableStream.
  // To get an async iterable, we call pipeThrough with an identity transform.
  const result = await model.doStream(args as LanguageModelV3CallOptions)
  const identityTransform = new TransformStream<LanguageModelV3StreamPart>()
  const readableStream = result.stream.pipeThrough(identityTransform)
  const reader = readableStream.getReader()

  // Track tool name from tool-input-start to tool-input-end
  let currentToolName: string | undefined

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const mappedChunk = mapStreamChunk(value, currentToolName)
      if (mappedChunk) {
        // Update currentToolName from tool-input-start
        if (mappedChunk.type === "tool-input-start") {
          currentToolName = mappedChunk.toolName
        }
        const loopInfo = detector.consumeChunk(mappedChunk, config)
        if (loopInfo) {
          throw new LoopDetectedError(loopInfo)
        }
      }
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

class DetectedStreamResult {
  private _stream: ReadableStream<LanguageModelV3StreamPart> | null = null

  constructor(
    private readonly generator: AsyncGenerator<LanguageModelV3StreamPart, void, unknown>,
  ) {}

  get stream(): ReadableStream<LanguageModelV3StreamPart> {
    if (this._stream === null) {
      const self = this
      this._stream = new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          const { value, done } = await self.generator.next()
          if (done) {
            controller.close()
            return
          }
          controller.enqueue(value)
        },
        async cancel() {
          await self.generator.return()
        },
      })
    }
    return this._stream
  }

  pipeThrough(transform: TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>): ReadableStream<LanguageModelV3StreamPart> {
    return this.stream.pipeThrough(transform)
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
    doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      if (!config.enabled) {
        return model.doStream(args as any) as any
      }

      async function* wrappedStream(): AsyncGenerator<LanguageModelV3StreamPart, void, unknown> {
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
          const prunedMessages = pruneLoopingMessages(args.prompt as Message[], config.pruneCount)

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
            prunedMsgs: args.prompt.length - prunedMessages.length,
            strategy: "nudge-and-prune",
          })

          // Reset detector state for the new attempt
          detector.reset()

          // Restart with modified messages — goes through loop detection again
          yield* streamWithDetection(model, detector, config, { ...args, prompt: nudgedMessages as any })
        }
      }

      return Promise.resolve(new DetectedStreamResult(wrappedStream()) as any)
    },
  }

  return wrapped
}

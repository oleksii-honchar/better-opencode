import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import * as Log from "@opencode-ai/core/util/log"
import type { UnstuckConfig } from "./config"
import { LoopDetectedError, type LoopDetectedInfo } from "./error"
import type { LoopDetector, StreamChunk } from "./loop-detector"
import { LoopDetectorImpl, EvidenceAccumulatorImpl } from "./loop-detector"

const log = Log.create({ service: "unstuck-plugin" })

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
  if (info.type === "self_diagnosis_loop") {
    return "You've acknowledged being stuck. Break out of this pattern and take a fundamentally different approach."
  }
  if (info.type === "pattern_loop") {
    return "You are oscillating between two states — this is a pattern loop. Break out and take a fundamentally different approach."
  }
  if (info.type === "xml_repetition") {
    if (info.exceedsTokenLimit) {
      const toolInfo = info.toolName ? ` for tool '${info.toolName}'` : ""
      return `Your tool input${toolInfo} has exceeded the token limit. You're generating too much content. Stop and provide a concise, complete tool input with only the required parameters.`
    }
    if (info.xmlTag) {
      const toolInfo = info.toolName ? ` for tool '${info.toolName}'` : ""
      return `You're repeating the XML tag '<${info.xmlTag}>'${toolInfo}. This indicates you're stuck in a loop producing incomplete parameters. Stop the repetition and compose a complete, valid tool call with all required parameters based on the tool schema provided.`
    }
    return "You're repeating XML tags while constructing a tool call. Stop the repetition and provide a complete, valid tool input with proper parameters."
  }
  if (info.type === "doom_loop") {
    const toolInfo = info.toolName ? ` '${info.toolName}'` : ""
    return `You keep calling the same tool${toolInfo} with the identical input repeatedly — this is a doom loop. Stop and change your approach: fix the input or try a different tool.`
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

function mapStreamChunk(chunk: LanguageModelV3StreamPart, toolNameMap: Map<string, string>): StreamChunk | undefined {
  // Map the AI SDK LanguageModelV3StreamPart to our StreamChunk type
  // toolNameMap tracks tool names keyed by id from tool-input-start to tool-input-end
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
        toolName: toolNameMap.get(chunk.id) ?? (chunk as any).toolName ?? "unknown",
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
  log.debug("streamWithDetection starting", { modelId: model.modelId })
  const result = await model.doStream(args as LanguageModelV3CallOptions)
  const identityTransform = new TransformStream<LanguageModelV3StreamPart>()
  const readableStream = result.stream.pipeThrough(identityTransform)
  const reader = readableStream.getReader()

  // Track tool name from tool-input-start to tool-input-end, keyed by id
  const toolNameMap = new Map<string, string>()
  let chunkCount = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunkCount++
      const mappedChunk = mapStreamChunk(value, toolNameMap)
      if (mappedChunk) {
        // Track tool name from tool-input-start
        if (mappedChunk.type === "tool-input-start") {
          toolNameMap.set(mappedChunk.id, mappedChunk.toolName)
          log.debug("tool-input-start", { id: mappedChunk.id, toolName: mappedChunk.toolName })
        }
        if (mappedChunk.type === "tool-input-end") {
          log.debug("tool-input-end", { id: mappedChunk.id, toolName: mappedChunk.toolName })
          // Cleanup after processing
          toolNameMap.delete(mappedChunk.id)
        }
        if (mappedChunk.type === "finish") {
          log.debug("finish chunk", { finishReason: mappedChunk.finishReason, chunkCount })
        }
        const loopInfo = detector.consumeChunk(mappedChunk, config)
        if (loopInfo) {
          const logLevel = loopInfo.type === "xml_repetition" ? log.info : log.debug
          logLevel("loop detected by detector", {
            type: loopInfo.type,
            threshold: loopInfo.threshold,
            chunkCount,
            xmlTag: loopInfo.xmlTag,
            toolName: loopInfo.toolName,
            exceedsTokenLimit: loopInfo.exceedsTokenLimit,
          })
          throw new LoopDetectedError(loopInfo)
        }
      }
      yield value
    }
    log.debug("streamWithDetection finished", { chunkCount })
  } finally {
    reader.releaseLock()
  }
}

class DetectedStreamResult {
  private _stream: ReadableStream<LanguageModelV3StreamPart> | null = null

  constructor(
    private readonly generator: AsyncGenerator<LanguageModelV3StreamPart, void, unknown>,
  ) {
    log.debug("DetectedStreamResult created")
  }

  get stream(): ReadableStream<LanguageModelV3StreamPart> {
    if (this._stream === null) {
      log.debug("DetectedStreamResult — creating ReadableStream from generator")
      const self = this
      this._stream = new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          const { value, done } = await self.generator.next()
          if (done) {
            log.debug("DetectedStreamResult — generator done, closing stream")
            controller.close()
            return
          }
          controller.enqueue(value)
        },
        async cancel() {
          log.debug("DetectedStreamResult — stream cancelled")
          await self.generator.return()
        },
      })
    }
    return this._stream
  }

  pipeThrough(transform: TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>): ReadableStream<LanguageModelV3StreamPart> {
    log.debug("DetectedStreamResult — pipeThrough called")
    return this.stream.pipeThrough(transform)
  }
}

export function wrapWithLoopDetection(
  model: LanguageModelV3,
  config: UnstuckConfig,
): LanguageModelV3 {
  log.debug("wrapWithLoopDetection", {
    modelId: model.modelId,
    provider: model.provider,
    enabled: config.enabled,
    strategy: config.strategy,
    maxNudges: config.maxNudges,
    loopThreshold: config.loopThreshold,
  })

  log.debug("doom_loop config", {
    enableDoomLoopDetection: config.enableDoomLoopDetection,
    doomLoopThreshold: config.doomLoopThreshold,
    evidenceDoomLoop: config.evidenceThresholds?.doomLoop,
  })

  const wrapped: LanguageModelV3 = {
    ...model,
    doStream(args: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      log.debug("doStream called", {
        promptLength: (args.prompt as any[]).length,
        maxOutputTokens: args.maxOutputTokens,
      })

      if (!config.enabled) {
        log.debug("unstuck disabled, passing through")
        return model.doStream(args as any) as any
      }

      // Per-stream isolation: fresh detector, evidence, and nudgeCount for each doStream call
      const detector = new LoopDetectorImpl()
      const evidence = new EvidenceAccumulatorImpl()
      let nudgeCount = 0

      async function* wrappedStream(): AsyncGenerator<LanguageModelV3StreamPart, void, unknown> {
        let chunkCount = 0
        let currentArgs: LanguageModelV3CallOptions = args

        while (true) {
          try {
            for await (const chunk of streamWithDetection(model, detector, config, currentArgs)) {
              chunkCount++
              yield chunk
            }
            // Clean finish — evidence and detector die with doStream, no explicit clear needed
            log.debug("stream completed normally", { chunkCount })
            return
          } catch (error) {
            if (!(error instanceof LoopDetectedError)) throw error

            log.debug("loop detected in stream", {
              chunkCount,
              type: error.info.type,
              threshold: error.info.threshold,
              xmlTag: error.info.xmlTag,
              toolName: error.info.toolName,
              exceedsTokenLimit: error.info.exceedsTokenLimit,
              strategy: config.strategy,
              nudgeCount,
              evidenceCount: evidence.count,
            })

            // --- Warn mode: log and rethrow ---
            if (config.strategy === "warn") {
              log.info("loop detected (warn mode)", {
                type: error.info.type,
                threshold: error.info.threshold,
                chunkCount,
              })
              throw error
            }

            // --- Abort mode: log and rethrow ---
            if (config.strategy === "abort") {
              log.info("loop detected (abort mode)", {
                type: error.info.type,
                threshold: error.info.threshold,
                chunkCount,
              })
              throw error
            }

            // --- Nudge-and-prune with evidence accumulation ---

            // Record this detection as evidence
            evidence.add(error.info, chunkCount, config)

            log.debug("evidence accumulated", {
              totalEvidence: evidence.count,
              byType: {
                stepLoop: evidence.countByType("step_loop"),
                toolLoop: evidence.countByType("tool_loop"),
                sentenceLoop: evidence.countByType("sentence_loop"),
                selfDiagnosis: evidence.countByType("self_diagnosis_loop"),
                xmlRepetition: evidence.countByType("xml_repetition"),
              },
            })

            // Check if threshold is met for intervention
            const thresholdResult = evidence.isThresholdMet(config)
            if (!thresholdResult.met) {
              const thresholdKey =
                error.info.type === "step_loop" ? "stepLoop"
                : error.info.type === "tool_loop" ? "toolLoop"
                : error.info.type === "sentence_loop" ? "sentenceLoop"
                : error.info.type === "self_diagnosis_loop" ? "selfDiagnosis"
                : error.info.type === "pattern_loop" ? "patternLoop"
                : error.info.type === "xml_repetition" ? "xmlRepetition"
                : error.info.type === "doom_loop" ? "doomLoop"
                : "stepLoop"
              log.info("loop detected but evidence below threshold — continuing stream", {
                type: error.info.type,
                evidenceCount: evidence.countByType(error.info.type),
                threshold: config.evidenceThresholds[thresholdKey],
              })

              // Reset streaming state but keep evidence and history
              detector.reset()

              // Loop back to top — restart stream with original args
              continue
            }

            // Threshold met — intervene with nudge
            if (nudgeCount >= config.maxNudges) {
              log.warn("max nudges reached, aborting", {
                maxNudges: config.maxNudges,
                fallback: "abort",
                type: error.info.type,
                toolName: error.info.toolName,
              })
              throw error
            }

            nudgeCount++
            log.debug("applying nudge", { nudgeCount, maxNudges: config.maxNudges })

            // Prune looping assistant messages
            const originalPrompt = currentArgs.prompt as Message[]
            const prunedMessages = pruneLoopingMessages(originalPrompt, config.pruneCount)

           // Inject nudge user message
            const nudgeMessage = config.nudgeMessage ?? defaultNudgeMessage(error.info)
            const nudgedMessages: Message[] = [
              ...prunedMessages,
              {
                role: "user",
                content: [{ type: "text" as const, text: nudgeMessage }],
                _unstuckNudge: true,
              },
            ]

            log.info("nudge applied", {
              nudgeCount,
              originalPromptLen: originalPrompt.length,
              prunedPromptLen: prunedMessages.length,
              prunedMsgs: originalPrompt.length - prunedMessages.length,
              strategy: "nudge-and-prune",
              loopType: error.info.type,
              toolName: error.info.toolName,
            })

            // Clear evidence and detector for fresh start
            evidence.clear()
            detector.clear()
            log.debug("evidence and detector cleared for nudge attempt")

            // Loop back to top — restart with nudged messages
            currentArgs = { ...currentArgs, prompt: nudgedMessages as any }
            continue
          }
        }
      }

      return Promise.resolve(new DetectedStreamResult(wrappedStream()) as any)
    },
  }

  return wrapped
}

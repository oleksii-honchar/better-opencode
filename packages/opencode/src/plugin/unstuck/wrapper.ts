import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import * as Log from "@opencode-ai/core/util/log"
import type { UnstuckConfig } from "./config"
import type { CrossStreamDoomLoopManager } from "./cross-stream-doom-loop"
import { LoopDetectedError, type LoopDetectedInfo } from "./error"
import { isIgnored } from "./cross-stream-doom-loop"
import type { LoopDetector, StreamChunk } from "./loop-detector"
import { LoopDetectorImpl, EvidenceAccumulatorImpl, computeInputFingerprint } from "./loop-detector"

const log = Log.create({ service: "unstuck-plugin" })

type Message = {
  role: "user" | "assistant" | "system" | "tool"
  content: unknown
  [key: string]: unknown
}

function defaultNudgeMessage(info: LoopDetectedInfo): string {
  if (info.type === "sentence_loop") {
    return `You are repeating the sentence "${info.sentence}" — this is a loop. Continue from your current task state instead of re-planning from scratch.`
  }
  if (info.type === "self_diagnosis_loop") {
    return "You've acknowledged being stuck. Break out of this pattern and take a fundamentally different approach."
  }
  if (info.type === "pattern_loop") {
    return "You are oscillating between two states — this is a pattern loop. Break out and take a fundamentally different approach."
  }
  if (info.type === "doom_loop") {
    const toolInfo = info.toolName ? ` '${info.toolName}'` : ""
    return `You keep calling the same tool${toolInfo} with the identical input repeatedly — this is a doom loop. Stop and change your approach: fix the input or try a different tool.`
  }
  return "You appear to be stuck in a loop — repeating the same thinking or tool calls. Break out of the pattern and take a different direction."
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

// Extract session ID from the prompt's <env> block.
// Walks through prompt array looking for "Session ID: ses_xxxxx" in system message content.
// Returns "" if not found or if prompt is not in expected format.
export function extractSessionId(prompt: unknown): string {
  if (!Array.isArray(prompt)) return ""
  for (const msg of prompt as Array<{ role?: string; content?: unknown }>) {
    const content = msg.content
    // Content can be a string or an array of { type, text }
    const textParts: string[] = []
    if (typeof content === "string") {
      textParts.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content as Array<{ type?: string; text?: string }>) {
        if (typeof part.text === "string") {
          textParts.push(part.text)
        }
      }
    }
    for (const text of textParts) {
      const match = text.match(/Session ID:\s*(ses_\w+)/)
      if (match) return match[1]
    }
  }
  return ""
}

async function* streamWithDetection(
  model: LanguageModelV3,
  detector: LoopDetector,
  config: UnstuckConfig,
  args: LanguageModelV3CallOptions,
  evidence: EvidenceAccumulatorImpl,
  crossStreamManager?: CrossStreamDoomLoopManager,
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

  // Extract session ID from prompt for cross-stream detection
  const sessionId = extractSessionId(args.prompt)

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
          log.debug("loop detected by detector", {
            type: loopInfo.type,
            threshold: loopInfo.threshold,
            chunkCount,
            toolName: loopInfo.toolName,
          })

          // Evidence-gated throw: accumulate evidence inline, throw only if threshold met
          evidence.add(loopInfo, chunkCount, config)

          const thresholdResult = evidence.isThresholdMet(config)
          if (thresholdResult.met) {
            throw new LoopDetectedError(loopInfo)
          }

          // Below threshold: reset detector and continue the SAME stream (no restart)
          log.info("loop detected but evidence below threshold — continuing same stream", {
            type: loopInfo.type,
            evidenceCount: evidence.countByType(loopInfo.type),
          })
          detector.reset()
        }

        // Cross-stream doom-loop detection: after per-stream check, on tool-input-end,
        // call manager.recordCall if cross-stream detection is enabled and manager exists.
        // Route through the SAME evidence gate as per-stream detections — never throw immediately.
        // NOTE: enableCrossStreamDoomLoopDetection defaults to false (opt-in).
        // Single-state design weakness (memory 0015): the cross-stream manager uses one
        // DoomLoopRunState per session, so if the model calls tool A, then tool B, then
        // tool A again with the same input, the run is broken — the count resets to 1
        // instead of continuing. This means cross-stream detection only catches truly
        // consecutive identical tool+input calls across streams, not interleaved patterns.
        if (mappedChunk.type === "tool-input-end" && !mappedChunk.providerExecuted) {
          if (config.enableCrossStreamDoomLoopDetection && crossStreamManager && sessionId) {
            const input = (mappedChunk as any).input ?? {}
            if (input._missing !== true) {
              // Skip recordCall if the tool input matches any ignore pattern
              const serialized = JSON.stringify(input)
              const shouldIgnore = isIgnored(config.doomLoopIgnorePatterns)(serialized)
              if (!shouldIgnore) {
                const inputFingerprint = computeInputFingerprint(input)
                const threshold = config.crossStreamDoomLoopThreshold ?? 3
                const thresholdReached = crossStreamManager.recordCall(
                  sessionId,
                  mappedChunk.toolName,
                  inputFingerprint,
                  threshold,
                )
                if (thresholdReached) {
                  log.info("cross-stream doom_loop detected", {
                    type: "doom_loop",
                    threshold,
                    toolName: mappedChunk.toolName,
                    inputFingerprint,
                    sessionId,
                  })

                  // Route through evidence gate — same as per-stream detections
                  const loopInfo: LoopDetectedInfo = {
                    type: "doom_loop",
                    threshold,
                    toolName: mappedChunk.toolName,
                    fingerprint: inputFingerprint,
                  }
                  evidence.add(loopInfo, chunkCount, config)

                  const thresholdResult = evidence.isThresholdMet(config)
                  if (thresholdResult.met) {
                    throw new LoopDetectedError(loopInfo)
                  }

                  // Below threshold: reset cross-stream run state and continue the same stream
                  log.info("cross-stream loop detected but evidence below threshold — continuing same stream", {
                    type: "doom_loop",
                    evidenceCount: evidence.countByType("doom_loop"),
                  })
                  crossStreamManager.resetSession(sessionId)
                }
              }
            }
          }
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
  crossStreamManager?: CrossStreamDoomLoopManager,
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

      // Extract session ID from prompt for cross-stream detection
      const sessionId = extractSessionId(args.prompt)

      async function* wrappedStream(): AsyncGenerator<LanguageModelV3StreamPart, void, unknown> {
        let chunkCount = 0
        let currentArgs: LanguageModelV3CallOptions = args

        while (true) {
          try {
            for await (const chunk of streamWithDetection(model, detector, config, currentArgs, evidence, crossStreamManager)) {
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
              toolName: error.info.toolName,
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

            // --- Nudge-and-prune (threshold already met — evidence accumulated in streamWithDetection) ---

            log.debug("evidence accumulated (threshold met)", {
              totalEvidence: evidence.count,
              byType: {
                stepLoop: evidence.countByType("step_loop"),
                toolLoop: evidence.countByType("tool_loop"),
                sentenceLoop: evidence.countByType("sentence_loop"),
                selfDiagnosis: evidence.countByType("self_diagnosis_loop"),
                doomLoop: evidence.countByType("doom_loop"),
              },
            })

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

            // Inject nudge user message
            const nudgeMessage = config.nudgeMessage ?? defaultNudgeMessage(error.info)
            const originalPrompt = currentArgs.prompt as Message[]
            const nudgedMessages: Message[] = [
              ...originalPrompt,
              {
                role: "user",
                content: [{ type: "text" as const, text: nudgeMessage }],
                _unstuckNudge: true,
              },
            ]

            log.info("nudge applied", {
              nudgeCount,
              originalPromptLen: originalPrompt.length,
              strategy: "nudge",
              loopType: error.info.type,
              toolName: error.info.toolName,
            })

            // Clear evidence and detector for fresh start
            evidence.clear()
            detector.clear()
            log.debug("evidence and detector cleared for nudge attempt")

            // Reset cross-stream manager for this session on nudge intervention
            if (crossStreamManager && sessionId) {
              crossStreamManager.resetSession(sessionId)
            }

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

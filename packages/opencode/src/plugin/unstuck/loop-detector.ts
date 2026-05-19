import * as Log from "@opencode-ai/core/util/log"
import type { UnstuckConfig } from "./config"
import { LoopDetectedError, type LoopDetectedInfo, type StepRecord } from "./error"
import { SentenceTracker } from "./sentence-tracker"

const log = Log.create({ service: "unstuck" })

function arraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// Synchronous hash function using FNV-1a — no external dependencies, no async
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function normalizeAndFingerprint(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[\s]+/g, " ")
    .replace(/[.,!?;:()\[\]{}"']/g, "")
    .trim()
  return fnv1a(normalized)
}

export function computeToolSignature(
  toolName: string,
  input?: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase()
  const inputKeys = input ? Object.keys(input).sort().join(",") : ""
  return `${name}:${inputKeys}`
}

export interface LoopDetector {
  consumeChunk(chunk: StreamChunk, config: UnstuckConfig): LoopDetectedInfo | undefined
  finalizeStep(config: UnstuckConfig): LoopDetectedInfo | undefined
  reset(): void
  getState(): DetectorState
}

export interface DetectorState {
  currentThinkingLength: number
  currentToolsCount: number
  historyLength: number
  inReasoning: boolean
}

export type StreamChunk =
  | { type: "reasoning-delta"; text: string }
  | { type: "text-delta"; text: string }
  | { type: "tool-input-start"; id: string; toolName: string; providerExecuted?: boolean }
  | { type: "tool-input-delta"; id: string; text: string }
  | { type: "tool-input-end"; id: string; toolName: string; input: Record<string, unknown>; providerExecuted?: boolean }
  | { type: "finish-step"; isCompaction?: boolean }
  | { type: "finish"; finishReason: string }

export class LoopDetectorImpl implements LoopDetector {
  private currentThinking = ""
  private currentTools: string[] = []
  private history: StepRecord[] = []
  private inReasoning = false
  private sentenceTracker = new SentenceTracker()
  private currentToolInputAccum: Record<string, string> = {}

  consumeChunk(chunk: StreamChunk, config: UnstuckConfig): LoopDetectedInfo | undefined {
    switch (chunk.type) {
      case "reasoning-delta": {
        this.inReasoning = true
        if (config.includeReasoning) {
          this.currentThinking += chunk.text
        }
        if (config.enableSentenceLoopDetection) {
          const sentenceLoopInfo = this.sentenceTracker.consumeText(chunk.text, config)
          if (sentenceLoopInfo) {
            log.info("loop detected", { type: "sentence_loop", threshold: sentenceLoopInfo.threshold, sentence: sentenceLoopInfo.sentence })
            return sentenceLoopInfo
          }
        }
        log.debug("chunk processed", { type: "reasoning-delta", accumulatedLen: this.currentThinking.length })
        break
      }

      case "text-delta": {
        this.inReasoning = false
        if (config.includeText) {
          this.currentThinking += chunk.text
        }
        if (config.enableSentenceLoopDetection) {
          const sentenceLoopInfo = this.sentenceTracker.consumeText(chunk.text, config)
          if (sentenceLoopInfo) {
            log.info("loop detected", { type: "sentence_loop", threshold: sentenceLoopInfo.threshold, sentence: sentenceLoopInfo.sentence })
            return sentenceLoopInfo
          }
        }
        log.debug("chunk processed", { type: "text-delta", accumulatedLen: this.currentThinking.length })
        break
      }

      case "tool-input-start": {
        log.debug("chunk processed", { type: "tool-input-start", toolName: chunk.toolName })
        break
      }

      case "tool-input-delta": {
        this.currentToolInputAccum[chunk.id] = (this.currentToolInputAccum[chunk.id] ?? "") + chunk.text
        break
      }

      case "tool-input-end": {
        // Skip provider-executed tools — they don't follow the same loop pattern
        if (chunk.providerExecuted) {
          log.debug("skipping provider-executed tool", { toolName: chunk.toolName })
          break
        }
        const sig = computeToolSignature(chunk.toolName, chunk.input)
        this.currentTools.push(sig)
        log.debug("chunk processed", { type: "tool-input-end", toolName: chunk.toolName, signature: sig })
        break
      }

      case "finish-step": {
        const result = this.finalizeStep(config)
        if (result) {
          log.info("loop detected", { type: result.type, threshold: result.threshold, fingerprint: result.fingerprint })
        }
        return result
      }

      case "finish": {
        // Stream ended — finalize any partial step
        const result = this.finalizeStep(config)
        if (result) {
          log.info("loop detected", { type: result.type, threshold: result.threshold, fingerprint: result.fingerprint })
        }
        return result
      }
    }
    return undefined
  }

  finalizeStep(config: UnstuckConfig): LoopDetectedInfo | undefined {
    // Skip compaction steps — they have a different purpose
    // This is handled by the caller passing isCompaction, but we check here too
    // by checking if thinking is empty and no tools

    const thinkingFp =
      this.currentThinking.length >= config.minThinkingLength
        ? normalizeAndFingerprint(this.currentThinking)
        : ""

    const stepFp = this.computeStepFingerprint(thinkingFp, this.currentTools)

    const record: StepRecord = {
      thinkingFingerprint: thinkingFp,
      toolSignatures: [...this.currentTools],
      stepFingerprint: stepFp,
    }

    this.history.push(record)

    // Keep only the last N steps
    if (this.history.length > config.historySize) {
      this.history.shift()
    }

    log.debug("step finalized", {
      fingerprint: stepFp,
      tools: this.currentTools.length,
      thinkingLen: this.currentThinking.length,
      historyLen: this.history.length,
    })

    // Check for loop
    const loopInfo = this.detectLoop(config)
    if (loopInfo) {
      return loopInfo
    }

    // Reset for next step
    this.currentThinking = ""
    this.currentTools = []
    this.currentToolInputAccum = {}
    this.inReasoning = false
    this.sentenceTracker.reset()

    return undefined
  }

  detectLoop(config: UnstuckConfig): LoopDetectedInfo | undefined {
    // Step-level loop detection
    const window = config.loopThreshold
    if (this.history.length >= window) {
      const recent = this.history.slice(-window)
      const first = recent[0].stepFingerprint
      if (recent.every((r) => r.stepFingerprint === first)) {
        return {
          type: "step_loop",
          threshold: window,
          fingerprint: first,
          steps: recent,
        }
      }
    }

    // Tool-only loop detection
    if (config.detectToolOnlyLoops) {
      const toolWindow = config.toolLoopThreshold
      if (this.history.length >= toolWindow) {
        const recentTools = this.history.slice(-toolWindow)
        const firstTools = recentTools[0].toolSignatures
        if (firstTools.length > 0) {
          const allSameTools = recentTools.every((r) => arraysEqual(r.toolSignatures, firstTools))
          if (allSameTools) {
            return {
              type: "tool_loop",
              threshold: toolWindow,
              steps: recentTools,
            }
          }
        }
      }
    }

    return undefined
  }

  private computeStepFingerprint(thinkingFp: string, toolSigs: string[]): string {
    return `${thinkingFp}|${toolSigs.join(";")}`
  }

  reset(): void {
    this.currentThinking = ""
    this.currentTools = []
    this.currentToolInputAccum = {}
    this.history = []
    this.inReasoning = false
    this.sentenceTracker.reset()
  }

  getState(): DetectorState {
    return {
      currentThinkingLength: this.currentThinking.length,
      currentToolsCount: this.currentTools.length,
      historyLength: this.history.length,
      inReasoning: this.inReasoning,
    }
  }
}

import * as Log from "@opencode-ai/core/util/log"
import { defaultEvidenceThresholds, type UnstuckConfig } from "./config"
import { LoopDetectedError, type EvidenceAccumulator, type EvidenceRecord, type LoopDetectedInfo, type StepRecord } from "./error"
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

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return `${name}:`
  }

  if (Object.keys(input).length === 0) {
    return `${name}:`
  }

  // Include both keys AND normalized values to avoid false positives.
  // Without values, "bash:command" matches ANY bash call (different commands = false positive).
  // Without values, "edit:filePath,newString,oldString" matches ANY edit (different files = false positive).
  const kvPairs = Object.entries(input)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v)
      // Normalize: lowercase, collapse whitespace, strip quotes
      return `${k}=${val.toLowerCase().replace(/[\s]+/g, " ").replace(/["']/g, "")}`
    })
    .join(";")

  return `${name}:${kvPairs}`
}

export interface LoopDetector {
  consumeChunk(chunk: StreamChunk, config: UnstuckConfig): LoopDetectedInfo | undefined
  finalizeStep(config: UnstuckConfig, finishReason?: string): LoopDetectedInfo | undefined
  // reset() — only clears streaming state, preserves history
  reset(): void
  // clear() — clears everything (used after clean completion or after nudge)
  clear(): void
  getState(): DetectorState
}

export interface DetectorState {
  currentReasoningLength: number
  currentTextLength: number
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
  | { type: "finish"; finishReason: string }

export class LoopDetectorImpl implements LoopDetector {
  private currentReasoning = ""
  private currentText = ""
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
          this.currentReasoning += chunk.text
        }
        if (config.enableSentenceLoopDetection) {
          const sentenceLoopInfo = this.sentenceTracker.consumeText(chunk.text, config)
          if (sentenceLoopInfo) {
            log.info("loop detected", { type: "sentence_loop", threshold: sentenceLoopInfo.threshold, sentence: sentenceLoopInfo.sentence })
            return sentenceLoopInfo
          }
        }
        log.debug("consumeChunk", { type: "reasoning-delta", reasoningLen: this.currentReasoning.length })
        break
      }

      case "text-delta": {
        this.inReasoning = false
        if (config.includeText) {
          this.currentText += chunk.text
        }
        if (config.enableSentenceLoopDetection) {
          const sentenceLoopInfo = this.sentenceTracker.consumeText(chunk.text, config)
          if (sentenceLoopInfo) {
            log.info("loop detected", { type: "sentence_loop", threshold: sentenceLoopInfo.threshold, sentence: sentenceLoopInfo.sentence })
            return sentenceLoopInfo
          }
        }
        log.debug("consumeChunk", { type: "text-delta", textLen: this.currentText.length })
        break
      }

      case "tool-input-start": {
        log.debug("consumeChunk", { type: "tool-input-start", id: chunk.id, toolName: chunk.toolName })
        break
      }

      case "tool-input-delta": {
        this.currentToolInputAccum[chunk.id] = (this.currentToolInputAccum[chunk.id] ?? "") + chunk.text
        break
      }

      case "tool-input-end": {
        // Skip provider-executed tools — they don't follow the same loop pattern
        if (chunk.providerExecuted) {
          log.debug("consumeChunk — skipping provider-executed tool", { type: "tool-input-end", toolName: chunk.toolName })
          break
        }

        // The AI SDK's tool-input-end chunk may not include `input` (or it may be empty).
        // Fall back to the accumulated delta text, which is the raw JSON streamed via
        // tool-input-delta chunks. Parse it to get the actual input for signature computation.
        let resolvedInput = chunk.input
        if (!resolvedInput || Object.keys(resolvedInput).length === 0) {
          const raw = this.currentToolInputAccum[chunk.id]
          if (raw) {
            try {
              const parsed = JSON.parse(raw)
              // Validate: must be a plain object (not null, not array, not primitive)
              if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                resolvedInput = parsed as Record<string, unknown>
                log.debug("consumeChunk — parsed input from delta", { type: "tool-input-end", toolName: chunk.toolName, keys: Object.keys(resolvedInput) })
              } else {
                log.warn("consumeChunk — parsed delta is not a plain object", { type: "tool-input-end", toolName: chunk.toolName, parsedType: typeof parsed })
              }
            } catch {
              log.warn("consumeChunk — failed to parse delta as JSON", { type: "tool-input-end", toolName: chunk.toolName, rawLength: raw.length })
            }
          }
        }

        // If input resolution failed completely, mark it to prevent false positives
        if (!resolvedInput || Object.keys(resolvedInput).length === 0) {
          resolvedInput = { _missing: true }
        }

        const sig = computeToolSignature(chunk.toolName, resolvedInput)
        this.currentTools.push(sig)
        log.debug("consumeChunk", { type: "tool-input-end", toolName: chunk.toolName, signature: sig, toolsInStep: this.currentTools.length })
        break
      }

      case "finish": {
        // finish with finishReason "tool-calls" signals step boundary
        // finish with finishReason "stop" (or other) signals stream end
        log.debug("consumeChunk — finish chunk", { type: "finish", finishReason: chunk.finishReason })
        const result = this.finalizeStep(config, chunk.finishReason)
        if (result) {
          log.info("loop detected at finish", { type: result.type, threshold: result.threshold, fingerprint: result.fingerprint, finishReason: chunk.finishReason })
        }
        return result
      }
    }
    return undefined
  }

  finalizeStep(config: UnstuckConfig, finishReason?: string): LoopDetectedInfo | undefined {
    log.debug("finalizeStep", { finishReason })

    const reasoningFp =
      this.currentReasoning.length >= config.minThinkingLength
        ? normalizeAndFingerprint(this.currentReasoning)
        : ""

    const textFp =
      this.currentText.length >= config.minThinkingLength
        ? normalizeAndFingerprint(this.currentText)
        : ""

    // Combined fingerprint for backward compatibility
    const thinkingFp = `${reasoningFp}|${textFp}`

    const stepFp = this.computeStepFingerprint(reasoningFp, textFp, this.currentTools)

    const record: StepRecord = {
      reasoningFingerprint: reasoningFp,
      textFingerprint: textFp,
      thinkingFingerprint: thinkingFp,
      toolSignatures: [...this.currentTools],
      stepFingerprint: stepFp,
    }

    this.history.push(record)

    // Keep only the last N steps
    if (this.history.length > config.historySize) {
      this.history.shift()
    }

    log.debug("finalizeStep", {
      fingerprint: stepFp,
      reasoningFingerprint: reasoningFp,
      textFingerprint: textFp,
      thinkingFingerprint: thinkingFp,
      toolSignatures: this.currentTools,
      tools: this.currentTools.length,
      reasoningLen: this.currentReasoning.length,
      textLen: this.currentText.length,
      historyLen: this.history.length,
    })

    // Check for loop
    const loopInfo = this.detectLoop(config)
    if (loopInfo) {
      log.info("finalizeStep — loop detected", {
        type: loopInfo.type,
        threshold: loopInfo.threshold,
        fingerprint: stepFp,
      })
      return loopInfo
    }

    // Reset for next step
    this.currentReasoning = ""
    this.currentText = ""
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
      const allMatch = recent.every((r) => r.stepFingerprint === first)
      log.debug("detectLoop — step check", {
        window,
        historyLen: this.history.length,
        firstFingerprint: first,
        allMatch,
        recentFingerprints: recent.map((r) => r.stepFingerprint),
      })
      if (allMatch) {
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
          log.debug("detectLoop — tool check", {
            toolWindow,
            historyLen: this.history.length,
            firstTools,
            allSameTools,
          })
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

  private computeStepFingerprint(reasoningFp: string, textFp: string, toolSigs: string[]): string {
    return `${reasoningFp}|${textFp}|${toolSigs.join(";")}`
  }

  reset(): void {
    log.debug("reset — clearing streaming state only")
    this.currentReasoning = ""
    this.currentText = ""
    this.currentTools = []
    this.currentToolInputAccum = {}
    // history is preserved for evidence accumulation within the same stream episode
    this.inReasoning = false
    this.sentenceTracker.reset()
  }

  clear(): void {
    log.debug("clear — clearing all detector state")
    this.currentReasoning = ""
    this.currentText = ""
    this.currentTools = []
    this.currentToolInputAccum = {}
    this.history = []
    this.inReasoning = false
    this.sentenceTracker.reset()
  }

  getState(): DetectorState {
    return {
      currentReasoningLength: this.currentReasoning.length,
      currentTextLength: this.currentText.length,
      currentThinkingLength: this.currentReasoning.length + this.currentText.length,
      currentToolsCount: this.currentTools.length,
      historyLength: this.history.length,
      inReasoning: this.inReasoning,
    }
  }
}

export class EvidenceAccumulatorImpl implements EvidenceAccumulator {
  private _records: EvidenceRecord[] = []

  get records(): readonly EvidenceRecord[] {
    return this._records
  }

  get count(): number {
    return this._records.length
  }

  countByType(type: "step_loop" | "tool_loop" | "sentence_loop"): number {
    return this._records.filter((r) => r.type === type).length
  }

  isThresholdMet(config: UnstuckConfig): { met: true; type: string } | { met: false } {
    const thresholds = config.evidenceThresholds ?? defaultEvidenceThresholds

    if (this.countByType("step_loop") >= (thresholds.stepLoop ?? 2)) {
      return { met: true, type: "step_loop" }
    }
    if (this.countByType("tool_loop") >= (thresholds.toolLoop ?? 2)) {
      return { met: true, type: "tool_loop" }
    }
    if (this.countByType("sentence_loop") >= (thresholds.sentenceLoop ?? 1)) {
      return { met: true, type: "sentence_loop" }
    }
    return { met: false }
  }

  add(info: LoopDetectedInfo, chunkCount: number, config?: UnstuckConfig): void {
    const record: EvidenceRecord = {
      type: info.type,
      fingerprint: info.fingerprint,
      sentence: info.sentence,
      threshold: info.threshold,
      detectedAtChunk: chunkCount,
      steps: info.steps,
      timestamp: Date.now(),
    }

    this._records.push(record)

    // Apply evidence window if configured
    const window = config?.evidenceWindow
    if (typeof window === "number" && isFinite(window) && window > 0 && this._records.length > window) {
      this._records = this._records.slice(-window)
    }
  }

  clear(): void {
    this._records = []
  }
}

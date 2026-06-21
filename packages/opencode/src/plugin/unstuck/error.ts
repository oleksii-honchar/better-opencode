export interface StepRecord {
  reasoningFingerprint: string
  textFingerprint: string
  thinkingFingerprint: string
  toolSignatures: string[]
  stepFingerprint: string
}

export interface LoopDetectedInfo {
  type: "step_loop" | "tool_loop" | "sentence_loop" | "self_diagnosis_loop" | "pattern_loop"
  threshold: number
  fingerprint?: string
  steps?: StepRecord[]
  sentence?: string
  firstIndex?: number
}

export interface EvidenceThresholds {
  stepLoop?: number
  toolLoop?: number
  sentenceLoop?: number
  selfDiagnosis?: number
  patternLoop?: number
}

export interface EvidenceRecord {
  type: "step_loop" | "tool_loop" | "sentence_loop" | "self_diagnosis_loop" | "pattern_loop"
  fingerprint?: string
  sentence?: string
  threshold: number
  detectedAtChunk: number
  steps?: StepRecord[]
  timestamp: number
}

export interface EvidenceAccumulator {
  readonly records: readonly EvidenceRecord[]

  get count(): number
  countByType(type: LoopDetectedInfo["type"]): number
  isThresholdMet(config: UnstuckConfig): { met: true; type: string } | { met: false }
  add(info: LoopDetectedInfo, chunkCount: number, config?: UnstuckConfig): void
  clear(): void
}

// Note: UnstuckConfig is imported from config.ts to avoid circular dependency issues.
// The EvidenceAccumulator interface references it for isThresholdMet.
import type { UnstuckConfig } from "./config"

export class LoopDetectedError extends Error {
  public readonly info: LoopDetectedInfo

  constructor(info: LoopDetectedInfo) {
    let message: string
    if (info.type === "sentence_loop") {
      message = `Model loop detected: sentence_loop — "${info.sentence}" repeated ${info.threshold} times periodically`
    } else if (info.type === "self_diagnosis_loop") {
      message = `Model loop detected: self_diagnosis_loop — model self-diagnosed being stuck (threshold: ${info.threshold})`
    } else {
      message = `Model loop detected: ${info.type} (threshold: ${info.threshold})`
    }
    super(message)
    this.name = "LoopDetectedError"
    this.info = info
  }
}

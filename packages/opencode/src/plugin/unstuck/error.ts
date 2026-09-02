export interface StepRecord {
  reasoningFingerprint: string
  textFingerprint: string
  thinkingFingerprint: string
  toolSignatures: string[]
  stepFingerprint: string
}

export interface LoopDetectedInfo {
  type: "step_loop" | "tool_loop" | "sentence_loop" | "self_diagnosis_loop" | "pattern_loop" | "doom_loop" | "fabricated_compliance"
  threshold: number
  fingerprint?: string
  steps?: StepRecord[]
  sentence?: string
  firstIndex?: number
  toolName?: string
  // fabricated_compliance: the matched compliance-claim phrase
  claim?: string
}

export interface EvidenceThresholds {
  stepLoop?: number
  toolLoop?: number
  sentenceLoop?: number
  selfDiagnosis?: number
  patternLoop?: number
  doomLoop?: number
  fabricatedCompliance?: number
}

export interface EvidenceRecord {
  type: "step_loop" | "tool_loop" | "sentence_loop" | "self_diagnosis_loop" | "pattern_loop" | "doom_loop" | "fabricated_compliance"
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
    } else if (info.type === "fabricated_compliance") {
      message = `Model loop detected: fabricated_compliance — compliance claim "${info.claim ?? "compliance"}" without any tool calls (threshold: ${info.threshold})`
    } else if (info.type === "doom_loop") {
      const toolInfo = info.toolName ? ` (tool: ${info.toolName})` : ""
      message = `Model loop detected: doom_loop — same tool called with identical input ${info.threshold} times in a row${toolInfo}`
    } else {
      message = `Model loop detected: ${info.type} (threshold: ${info.threshold})`
    }
    super(message)
    this.name = "LoopDetectedError"
    this.info = info
  }
}

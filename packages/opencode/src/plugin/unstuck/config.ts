import type { EvidenceThresholds } from "./error"

export interface ModelSpecificThresholds {
  qwen: {
    repetitionThreshold: number
    maxToolInputTokens: number
    partialTagThreshold: number
  }
}

export const defaultEvidenceThresholds: EvidenceThresholds = {
  stepLoop: 2,
  toolLoop: 2,
  sentenceLoop: 1,
  selfDiagnosis: 2,
  patternLoop: 2,
  xmlRepetition: 1,
}

export interface UnstuckConfig {
  enabled: boolean
  loopThreshold: number
  detectToolOnlyLoops: boolean
  toolLoopThreshold: number
  historySize: number
  minThinkingLength: number
  includeReasoning: boolean
  includeText: boolean
  enableSentenceLoopDetection: boolean
  sentenceLoopThreshold: number
  minSentenceLength: number
  enableSelfDiagnosisDetection: boolean
  enablePatternLoopDetection: boolean
  patternLoopThreshold: number
  enableXmlRepetition: boolean
  xmlRepetitionThreshold: number
  xmlRepetitionWindowSize: number
  maxToolInputTokens: number
  maxTotalToolInputTokens: number
  // Model ID for model-specific threshold overrides (e.g. qwen gets more sensitive detection)
  modelId?: string
  // Model-specific threshold configuration
  modelSpecificThresholds?: ModelSpecificThresholds
  // Model ID specifically for XML repetition detection (maps to XmlRepetitionConfig.modelId)
  xmlRepetitionModelId?: string
  // Threshold for partial/incomplete XML tags (maps to XmlRepetitionConfig.partialTagThreshold)
  xmlPartialTagThreshold: number
  // Enable/disable partial tag detection
  xmlPartialTagDetection: boolean
  // Multiplier for XML content token estimation (maps to XmlRepetitionConfig.xmlTokenEstimationMultiplier)
  xmlTokenEstimationMultiplier: number
  strategy: "nudge-and-prune" | "abort" | "warn"
  maxNudges: number
  pruneCount: number
  nudgeMessage?: string
  logLevel: "debug" | "info" | "warn"
  evidenceThresholds: EvidenceThresholds
  evidenceWindow: number
}

export const defaultConfig: UnstuckConfig = {
  enabled: true,
  loopThreshold: 3,
  detectToolOnlyLoops: true,
  toolLoopThreshold: 6,
  historySize: 10,
  minThinkingLength: 50,
  includeReasoning: true,
  includeText: true,
  enableSentenceLoopDetection: true,
  sentenceLoopThreshold: 3,
  minSentenceLength: 15,
  enableSelfDiagnosisDetection: true,
  enablePatternLoopDetection: true,
  patternLoopThreshold: 4,
  enableXmlRepetition: true,
  xmlRepetitionThreshold: 4,
  xmlRepetitionWindowSize: 10,
  maxToolInputTokens: 4000,
  maxTotalToolInputTokens: 16000,
  xmlRepetitionModelId: undefined,
  xmlPartialTagThreshold: 2,
  xmlPartialTagDetection: true,
  xmlTokenEstimationMultiplier: 1.5,
  strategy: "nudge-and-prune",
  maxNudges: 2,
  pruneCount: 3,
  nudgeMessage: "You appear to be stuck in a loop — repeating the same thinking or tool calls. Break out of the pattern and take a different direction.",
  logLevel: "info",
  evidenceThresholds: defaultEvidenceThresholds,
  evidenceWindow: Infinity,
}

export function validateUnstuckConfig(config: UnstuckConfig): UnstuckConfig {
  const result = { ...config }

  if (result.xmlPartialTagThreshold < 1) {
    result.xmlPartialTagThreshold = defaultConfig.xmlPartialTagThreshold
  }

  if (result.xmlTokenEstimationMultiplier < 1.0) {
    result.xmlTokenEstimationMultiplier = defaultConfig.xmlTokenEstimationMultiplier
  }

  if (result.xmlRepetitionThreshold < 1) {
    result.xmlRepetitionThreshold = defaultConfig.xmlRepetitionThreshold
  }

  return result
}

export function mergeConfig(partial: Partial<UnstuckConfig>): UnstuckConfig {
  const merged = {
    ...defaultConfig,
    ...partial,
    evidenceThresholds: partial.evidenceThresholds
      ? { ...defaultConfig.evidenceThresholds, ...partial.evidenceThresholds }
      : defaultConfig.evidenceThresholds,
  }
  return validateUnstuckConfig(merged)
}

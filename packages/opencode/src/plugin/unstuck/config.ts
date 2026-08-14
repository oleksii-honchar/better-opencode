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
  doomLoop: 1,
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
  enableXmlRepetitionGuard: boolean
  xmlRepetitionThreshold: number
  xmlRepetitionWindowSize: number
  // Enable doom-loop detection (same tool called with identical input repeatedly)
  enableDoomLoopDetection: boolean
  // Number of identical tool+input calls in a row to declare a doom loop (matches DOOM_LOOP_THRESHOLD)
  doomLoopThreshold: number
  // Enable cross-stream doom-loop detection (tracks identical tool+input across separate doStream calls)
  enableCrossStreamDoomLoopDetection: boolean
  // Threshold for cross-stream doom-loop detection (number of identical calls across streams to trigger)
  crossStreamDoomLoopThreshold: number
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
  strategy: "nudge" | "nudge-and-prune" | "abort" | "warn"
  maxNudges: number
  nudgeMessage?: string
  logLevel: "debug" | "info" | "warn"
  evidenceThresholds: EvidenceThresholds
  evidenceWindow: number
}

export const defaultConfig: UnstuckConfig = {
  // Master switch — when false, all loop detection is bypassed
  enabled: true,
  // Number of identical consecutive steps (reasoning+text+tools fingerprint) to declare a step-level loop
  loopThreshold: 3,
  // When true, also detect loops that consist of tool calls only (no reasoning/text change)
  detectToolOnlyLoops: true,
  // Number of consecutive tool-only steps with same tool signature to declare a tool-level loop
  toolLoopThreshold: 6,
  // How many past steps to keep in history for loop comparison
  historySize: 10,
  // Minimum character length of reasoning/text before it's considered for fingerprinting (avoids noise from short outputs)
  minThinkingLength: 50,
  // Include reasoning content in step fingerprint (set false to ignore reasoning-only changes)
  includeReasoning: true,
  // Include text content in step fingerprint (set false to ignore text-only changes)
  includeText: true,
  // Enable sentence-level repetition detection (catches "I'll try X... I'll try X...")
  enableSentenceLoopDetection: true,
  // Number of identical sentences in a row to declare a sentence loop
  sentenceLoopThreshold: 3,
  // Minimum character length of a sentence before it's considered for repetition detection
  minSentenceLength: 15,
  // Enable self-diagnosis detection (catches "I'm stuck", "I cannot proceed", etc.)
  enableSelfDiagnosisDetection: true,
  // Enable pattern loop detection (catches alternating A-B-A-B step patterns)
  enablePatternLoopDetection: true,
  // Number of steps in an alternating pattern to declare a pattern loop
  patternLoopThreshold: 4,
  // Enable XML repetition detection for tool input streaming (catches repeated <tag>...</tag> in tool calls)
  enableXmlRepetitionGuard: true,
  // Number of identical XML tags in the sliding window to declare an XML repetition loop
  xmlRepetitionThreshold: 4,
  // Sliding window size for XML tag repetition counting
  xmlRepetitionWindowSize: 10,
  // Enable doom-loop detection (same tool called with identical input repeatedly)
  enableDoomLoopDetection: true,
  // Number of identical tool+input calls in a row to declare a doom loop (matches DOOM_LOOP_THRESHOLD)
  doomLoopThreshold: 3,
  // Enable cross-stream doom-loop detection (tracks identical tool+input across separate doStream calls)
  enableCrossStreamDoomLoopDetection: true,
  // Threshold for cross-stream doom-loop detection (number of identical calls across streams to trigger)
  crossStreamDoomLoopThreshold: 3,
  // Maximum estimated tokens per single tool input before triggering a token-limit XML loop
  maxToolInputTokens: 4000,
  // Maximum estimated total tokens across all tool inputs in the current stream before triggering a token-limit XML loop
  maxTotalToolInputTokens: 16000,
  // Model ID for model-specific threshold overrides (e.g. "qwen" gets more sensitive detection); undefined = no override
  xmlRepetitionModelId: undefined,
  // Threshold for partial/incomplete XML tags (more sensitive than full tags — catches Qwen-style malformed output)
  xmlPartialTagThreshold: 2,
  // Enable/disable partial tag detection (catches <tag, <tag=, etc. without closing >)
  xmlPartialTagDetection: true,
  // Multiplier for XML content token estimation (1.5 = 50% more conservative than plain text; triggers earlier interruption)
  xmlTokenEstimationMultiplier: 1.5,
  // Intervention strategy: "nudge" (inject recovery prompt only), "nudge-and-prune" (legacy alias), "abort" (throw immediately), "warn" (log and throw)
  strategy: "nudge",
  // Maximum number of nudge attempts before giving up and aborting (increased to 10 for XML repetition recovery)
  maxNudges: 10,
  // Custom nudge message (overrides the default context-aware nudge generator)
  nudgeMessage: "You appear to be stuck in a loop — repeating the same thinking or tool calls. Break out of the pattern and take a different direction.",
  // Log verbosity: "debug" (all), "info" (detections + interventions), "warn" (interventions only)
  logLevel: "info",
  // Per-detection-type evidence thresholds — how many detections of each type before intervention
  evidenceThresholds: defaultEvidenceThresholds,
  // Number of past detections to consider for evidence accumulation (Infinity = no expiration)
  evidenceWindow: Infinity,
}

export function validateUnstuckConfig(config: UnstuckConfig): UnstuckConfig {
  let result = { ...config }
  // pruneCount was removed — strip it if present in input
  delete (result as any).pruneCount

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
  let merged = {
    ...defaultConfig,
    ...partial,
    evidenceThresholds: partial.evidenceThresholds
      ? { ...defaultConfig.evidenceThresholds, ...partial.evidenceThresholds }
      : defaultConfig.evidenceThresholds,
  }
  // pruneCount was removed — strip it if present in input
  delete (merged as any).pruneCount
  return validateUnstuckConfig(merged)
}

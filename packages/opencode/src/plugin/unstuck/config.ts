import type { EvidenceThresholds } from "./error"

export const defaultEvidenceThresholds: EvidenceThresholds = {
  stepLoop: 2,
  toolLoop: 2,
  sentenceLoop: 3,
  selfDiagnosis: 3,
  patternLoop: 2,
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
  // Enable doom-loop detection (same tool called with identical input repeatedly)
  enableDoomLoopDetection: boolean
  // Number of identical tool+input calls in a row to declare a doom loop (matches DOOM_LOOP_THRESHOLD)
  doomLoopThreshold: number
  // Enable cross-stream doom-loop detection (tracks identical tool+input across separate doStream calls)
  enableCrossStreamDoomLoopDetection: boolean
  // Threshold for cross-stream doom-loop detection (number of identical calls across streams to trigger)
  crossStreamDoomLoopThreshold: number
  // Whether sentence_loop detection includes reasoning-delta content (default false to avoid CoT false positives)
  sentenceLoopIncludeReasoning: boolean
  // Regex patterns to ignore in doom_loop detection (e.g., rule-file paths)
  doomLoopIgnorePatterns: string[]
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
  // Enable doom-loop detection (same tool called with identical input repeatedly)
  enableDoomLoopDetection: true,
  // Number of identical tool+input calls in a row to declare a doom loop (matches DOOM_LOOP_THRESHOLD)
  doomLoopThreshold: 3,
  // Enable cross-stream doom-loop detection (tracks identical tool+input across separate doStream calls)
  enableCrossStreamDoomLoopDetection: false,
  // Threshold for cross-stream doom-loop detection (number of identical calls across streams to trigger)
  crossStreamDoomLoopThreshold: 3,
  // Whether sentence_loop detection includes reasoning-delta content (default false to avoid CoT false positives)
  sentenceLoopIncludeReasoning: false,
  // Regex patterns to ignore in doom_loop detection (e.g., rule-file paths like ~/.rules/ and .mdc files)
  doomLoopIgnorePatterns: ["/\\.rules\\/", "\\.mdc"],
  // Intervention strategy: "nudge" (inject recovery prompt only), "nudge-and-prune" (legacy alias), "abort" (throw immediately), "warn" (log and throw)
  strategy: "nudge",
  // Maximum number of nudge attempts before giving up and aborting
  maxNudges: 2,
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

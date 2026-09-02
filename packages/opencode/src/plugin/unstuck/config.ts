import type { EvidenceThresholds } from "./error"

export const defaultEvidenceThresholds: EvidenceThresholds = {
  stepLoop: 2,
  toolLoop: 2,
  sentenceLoop: 3,
  selfDiagnosis: 3,
  patternLoop: 2,
  doomLoop: 1,
  // fabricated_compliance fires once per qualifying turn — one strike is enough for a nudge
  fabricatedCompliance: 1,
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
  // Enable fabricated-compliance detection (catches "initialized"/"activated" claims with zero tool calls)
  // DEFAULT OFF (D5) — opt-in per agent via the `unstuck` config block
  enableFabricatedComplianceDetection: boolean
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
  // Enable fabricated-compliance detection (catches "initialized"/"activated" claims with zero tool calls)
  // DEFAULT OFF (D5) — opt-in per agent via the `unstuck` config block
  enableFabricatedComplianceDetection: false,
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
  // Custom nudge message (overrides the default context-aware nudge generator).
  // Default is undefined — the wrapper resolves per-detection-type phrasing first,
  // then this override, then the generic loop nudge. (Task 8b: keeping the generic
  // text here made explicit overrides indistinguishable from the default.)
  nudgeMessage: undefined,
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

// Per-agent unstuck resolution (Task 8b): agent frontmatter `unstuck:` blocks are
// promoted to `agent.options.unstuck` (config/agent.ts unknown-key handling) as raw
// JSON. Validate the shape defensively before merging — invalid shapes are ignored
// so a malformed agent block can never disable or corrupt loop detection.
const BOOLEAN_KEYS = [
  "enabled",
  "detectToolOnlyLoops",
  "includeReasoning",
  "includeText",
  "enableSentenceLoopDetection",
  "enableSelfDiagnosisDetection",
  "enableFabricatedComplianceDetection",
  "enablePatternLoopDetection",
  "enableDoomLoopDetection",
  "enableCrossStreamDoomLoopDetection",
  "sentenceLoopIncludeReasoning",
] as const

const NUMBER_KEYS = [
  "loopThreshold",
  "toolLoopThreshold",
  "historySize",
  "minThinkingLength",
  "sentenceLoopThreshold",
  "minSentenceLength",
  "patternLoopThreshold",
  "doomLoopThreshold",
  "crossStreamDoomLoopThreshold",
  "maxNudges",
  "evidenceWindow",
] as const

const STRING_KEYS = ["nudgeMessage"] as const

const STRATEGY_VALUES = ["nudge", "nudge-and-prune", "abort", "warn"] as const
const LOG_LEVEL_VALUES = ["debug", "info", "warn"] as const

const EVIDENCE_THRESHOLD_KEYS = [
  "stepLoop",
  "toolLoop",
  "sentenceLoop",
  "selfDiagnosis",
  "patternLoop",
  "doomLoop",
  "fabricatedCompliance",
] as const

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function resolveAgentUnstuckConfig(
  globalUnstuck: Partial<UnstuckConfig> | undefined,
  agentUnstuck: unknown,
): UnstuckConfig {
  const agentPartial: Partial<UnstuckConfig> = {}

  if (isPlainObject(agentUnstuck)) {
    for (const key of BOOLEAN_KEYS) {
      if (hasOwn(agentUnstuck, key) && typeof agentUnstuck[key] === "boolean") {
        ;(agentPartial as Record<string, unknown>)[key] = agentUnstuck[key]
      }
    }
    for (const key of NUMBER_KEYS) {
      if (hasOwn(agentUnstuck, key) && typeof agentUnstuck[key] === "number" && Number.isFinite(agentUnstuck[key])) {
        ;(agentPartial as Record<string, unknown>)[key] = agentUnstuck[key]
      }
    }
    if (hasOwn(agentUnstuck, "strategy") && STRATEGY_VALUES.includes(agentUnstuck["strategy"] as never)) {
      agentPartial.strategy = agentUnstuck["strategy"] as UnstuckConfig["strategy"]
    }
    if (hasOwn(agentUnstuck, "logLevel") && LOG_LEVEL_VALUES.includes(agentUnstuck["logLevel"] as never)) {
      agentPartial.logLevel = agentUnstuck["logLevel"] as UnstuckConfig["logLevel"]
    }
    if (hasOwn(agentUnstuck, "nudgeMessage") && typeof agentUnstuck["nudgeMessage"] === "string") {
      agentPartial.nudgeMessage = agentUnstuck["nudgeMessage"]
    }
    if (hasOwn(agentUnstuck, "doomLoopIgnorePatterns") && Array.isArray(agentUnstuck["doomLoopIgnorePatterns"])) {
      const patterns = (agentUnstuck["doomLoopIgnorePatterns"] as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
      if (patterns.length > 0) agentPartial.doomLoopIgnorePatterns = patterns
    }
    const rawThresholds = agentUnstuck["evidenceThresholds"]
    if (hasOwn(agentUnstuck, "evidenceThresholds") && isPlainObject(rawThresholds)) {
      const thresholds: Record<string, number> = {}
      for (const key of EVIDENCE_THRESHOLD_KEYS) {
        const value = rawThresholds[key]
        if (hasOwn(rawThresholds, key) && typeof value === "number" && Number.isFinite(value)) {
          thresholds[key] = value
        }
      }
      if (Object.keys(thresholds).length > 0) {
        agentPartial.evidenceThresholds = thresholds
      }
    }
  }

  return mergeConfig({
    ...globalUnstuck,
    ...agentPartial,
    evidenceThresholds: { ...globalUnstuck?.evidenceThresholds, ...agentPartial.evidenceThresholds },
  })
}

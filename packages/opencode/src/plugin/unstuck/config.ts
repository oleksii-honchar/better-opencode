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
  strategy: "nudge-and-prune" | "abort" | "warn"
  maxNudges: number
  pruneCount: number
  nudgeMessage?: string
  logLevel: "debug" | "info" | "warn"
}

export const defaultConfig: UnstuckConfig = {
  enabled: true,
  loopThreshold: 3,
  detectToolOnlyLoops: true,
  toolLoopThreshold: 4,
  historySize: 10,
  minThinkingLength: 50,
  includeReasoning: true,
  includeText: true,
  enableSentenceLoopDetection: true,
  sentenceLoopThreshold: 3,
  minSentenceLength: 15,
  strategy: "nudge-and-prune",
  maxNudges: 2,
  pruneCount: 3,
  nudgeMessage: "You appear to be stuck in a loop — repeating the same thinking or tool calls. Break out of the pattern and take a different direction.",
  logLevel: "info",
}

export function mergeConfig(partial: Partial<UnstuckConfig>): UnstuckConfig {
  return { ...defaultConfig, ...partial }
}

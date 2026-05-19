export interface StepRecord {
  thinkingFingerprint: string
  toolSignatures: string[]
  stepFingerprint: string
}

export interface LoopDetectedInfo {
  type: "step_loop" | "tool_loop" | "sentence_loop"
  threshold: number
  fingerprint?: string
  steps?: StepRecord[]
  sentence?: string
  firstIndex?: number
}

export class LoopDetectedError extends Error {
  public readonly info: LoopDetectedInfo

  constructor(info: LoopDetectedInfo) {
    let message: string
    if (info.type === "sentence_loop") {
      message = `Model loop detected: sentence_loop — "${info.sentence}" repeated ${info.threshold} times periodically`
    } else {
      message = `Model loop detected: ${info.type} (threshold: ${info.threshold})`
    }
    super(message)
    this.name = "LoopDetectedError"
    this.info = info
  }
}

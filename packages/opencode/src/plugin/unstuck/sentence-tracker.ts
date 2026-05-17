import type { UnstuckConfig } from "./config"
import type { LoopDetectedInfo } from "./error"

interface SentenceRecord {
  text: string
  fingerprint: string
}

export class SentenceTracker {
  private history: SentenceRecord[] = []
  private maxHistory = 50
  private inCodeBlock = false

  consumeText(textChunk: string, config: UnstuckConfig): LoopDetectedInfo | undefined {
    // Track code blocks — skip text inside them
    const segments = this.splitCodeBlocks(textChunk)

    for (const segment of segments) {
      if (segment.type === "code") continue

      const sentences = this.splitIntoSentences(segment.text)

      for (const sentence of sentences) {
        // Filter by minimum length
        if (sentence.trim().length < config.minSentenceLength) continue

        const fp = this.normalizeAndFingerprint(sentence)
        if (fp === undefined) continue  // Skip structural patterns (no letter content)

        this.history.push({ text: sentence, fingerprint: fp })

        // Evict old entries
        if (this.history.length > this.maxHistory) {
          this.history.shift()
        }

        // Check for periodic repetition
        const loopInfo = this.detectSentenceLoop(config)
        if (loopInfo) return loopInfo
      }
    }

    return undefined
  }

  private detectSentenceLoop(config: UnstuckConfig): LoopDetectedInfo | undefined {
    const history = this.history
    if (history.length < config.sentenceLoopThreshold + 2) return undefined

    const windowSize = Math.min(history.length, 20)
    const recent = history.slice(-windowSize)

    for (let i = 0; i < recent.length; i++) {
      const target = recent[i]
      const matchIndices: number[] = []

      // Collect all indices where this sentence appears
      for (let j = i + 1; j < recent.length; j++) {
        if (recent[j].fingerprint === target.fingerprint) {
          matchIndices.push(j)
        }
      }

      if (matchIndices.length + 1 < config.sentenceLoopThreshold) continue

      // Check for periodic pattern — gaps between consecutive matches should be consistent
      let consistentPeriod = true
      let firstGap = matchIndices[0] - i
      for (let k = 1; k < matchIndices.length; k++) {
        const gap = matchIndices[k] - matchIndices[k - 1]
        if (Math.abs(gap - firstGap) > 1) {
          // Gap varies by more than 1 — not a consistent periodic pattern
          consistentPeriod = false
          break
        }
      }

      if (consistentPeriod && firstGap >= 1 && firstGap <= 5) {
        return {
          type: "sentence_loop",
          threshold: matchIndices.length + 1,
          sentence: target.text,
          fingerprint: target.fingerprint,
          firstIndex: i,
        }
      }
    }

    return undefined
  }

  private splitIntoSentences(text: string): string[] {
    // Split on ". " / "? " / "! " followed by any letter, also on newlines
    const splits = text.split(/(?<=[.!?])\s+(?=[a-zA-Z])/g)
    return splits
      .flatMap((s) => s.split(/\n+/))
      .filter((s) => s.trim().length > 10)
  }

  private normalizeAndFingerprint(text: string): string | undefined {
    const normalized = text
      .toLowerCase()
      .replace(/[\s]+/g, " ")
      .replace(/[.,!?;:()\[\]{}"']/g, "")
      .trim()
      .slice(0, 100)

    // Skip structural patterns: dashes, asterisks, bullets, etc. (no letter content)
    if (!/[a-z]/.test(normalized)) {
      return undefined
    }

    return normalized
  }

  private splitCodeBlocks(text: string): Array<{ type: "code" | "text"; text: string }> {
    const segments: Array<{ type: "code" | "text"; text: string }> = []
    const parts = text.split(/```/)

    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        // Even indices are outside code blocks
        if (parts[i].length > 0) segments.push({ type: "text", text: parts[i] })
      } else {
        // Odd indices are inside code blocks — skip
        segments.push({ type: "code", text: parts[i] })
      }
    }

    return segments
  }

  reset(): void {
    this.history = []
    this.inCodeBlock = false
  }
}

import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "unstuck" })

// Regex patterns for XML tag extraction
// Matches opening/closing pairs: <tagName ...>...</tagName>
const XML_TAG_PATTERN = /<(\w+?)(\s[^>]*)?>.*?<\/\1>/gs
// Matches self-closing tags: <tagName .../>
const XML_SELF_CLOSING_PATTERN = /<(\w+?)(\s[^>]*)?\/>/g

export interface XmlRepetitionConfig {
  repetitionThreshold: number
  windowSize: number
  maxToolInputTokens: number
  maxTotalTokens: number
}

export interface RepetitionDetected {
  type: "xml_repetition"
  tagName: string
  repetitionCount: number
  totalTokens: number
  exceedsTokenLimit: boolean
}

export interface RepetitionState {
  tagWindowLength: number
  currentToolTokens: number
  totalTokens: number
}

interface TagEntry {
  tagName: string
  fingerprint: string
}

export class XmlRepetitionDetector {
  private config: XmlRepetitionConfig
  private tagWindow: TagEntry[] = []
  private currentToolTokens: number = 0
  private totalTokens: number = 0

  constructor(config: XmlRepetitionConfig) {
    this.config = config
  }

  reset(): void {
    log.debug("XmlRepetitionDetector — reset")
    this.tagWindow = []
    this.currentToolTokens = 0
    // totalTokens is preserved across tool resets
  }

  clear(): void {
    log.debug("XmlRepetitionDetector — clear")
    this.tagWindow = []
    this.currentToolTokens = 0
    this.totalTokens = 0
  }

  consumeDelta(_toolName: string, text: string, tokens: number): RepetitionDetected | undefined {
    // Accumulate tokens
    this.currentToolTokens += tokens
    this.totalTokens += tokens

    // Check per-tool token limit
    if (this.currentToolTokens >= this.config.maxToolInputTokens) {
      log.info("XmlRepetitionDetector — per-tool token limit exceeded", {
        tool: _toolName,
        tokens: this.currentToolTokens,
        limit: this.config.maxToolInputTokens,
      })
      return {
        type: "xml_repetition",
        tagName: "",
        repetitionCount: 0,
        totalTokens: this.totalTokens,
        exceedsTokenLimit: true,
      }
    }

    // Check total token limit
    if (this.totalTokens >= this.config.maxTotalTokens) {
      log.info("XmlRepetitionDetector — total token limit exceeded", {
        tokens: this.totalTokens,
        limit: this.config.maxTotalTokens,
      })
      return {
        type: "xml_repetition",
        tagName: "",
        repetitionCount: 0,
        totalTokens: this.totalTokens,
        exceedsTokenLimit: true,
      }
    }

    // Extract and process XML tags
    const tags = this.extractTags(text)
    for (const tagName of tags) {
      this.processTag(tagName)
      const detection = this.checkRepetition()
      if (detection) {
        return detection
      }
    }

    return undefined
  }

  getState(): RepetitionState {
    return {
      tagWindowLength: this.tagWindow.length,
      currentToolTokens: this.currentToolTokens,
      totalTokens: this.totalTokens,
    }
  }

  private extractTags(text: string): string[] {
    const tags: string[] = []

    // Extract opening/closing pairs
    let match: RegExpExecArray | null
    const tagRegex = new RegExp(XML_TAG_PATTERN)
    while ((match = tagRegex.exec(text)) !== null) {
      const tagName = match[1].toLowerCase()
      tags.push(tagName)
    }

    // Extract self-closing tags
    const selfClosingRegex = new RegExp(XML_SELF_CLOSING_PATTERN)
    while ((match = selfClosingRegex.exec(text)) !== null) {
      const tagName = match[1].toLowerCase()
      tags.push(tagName)
    }

    return tags
  }

  private processTag(tagName: string): void {
    // Normalize: lowercase (already done in extraction), collapse whitespace
    const normalized = tagName.toLowerCase().replace(/\s+/g, "")
    const fingerprint = this.fnv1a(normalized)

    // Add to sliding window
    this.tagWindow.push({ tagName: normalized, fingerprint })

    // Maintain window size
    if (this.tagWindow.length > this.config.windowSize) {
      this.tagWindow.shift()
    }
  }

  private checkRepetition(): RepetitionDetected | undefined {
    // Count occurrences of each fingerprint in the window
    const counts = new Map<string, number>()
    const nameByFp = new Map<string, string>()
    for (const entry of this.tagWindow) {
      counts.set(entry.fingerprint, (counts.get(entry.fingerprint) ?? 0) + 1)
      nameByFp.set(entry.fingerprint, entry.tagName)
    }

    for (const [fp, count] of counts) {
      if (count >= this.config.repetitionThreshold) {
        const tagName = nameByFp.get(fp) ?? "unknown"
        log.info("XmlRepetitionDetector — repetition detected", {
          tagName,
          count,
          threshold: this.config.repetitionThreshold,
        })
        return {
          type: "xml_repetition",
          tagName,
          repetitionCount: count,
          totalTokens: this.totalTokens,
          exceedsTokenLimit: false,
        }
      }
    }

    return undefined
  }

  // FNV-1a hash — same as in loop-detector.ts, kept local to avoid circular deps
  private fnv1a(text: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, "0")
  }
}

import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "unstuck" })

// Regex patterns for XML tag extraction
// Matches opening/closing pairs: <tagName ...>...</tagName>
const XML_TAG_PATTERN = /<(\w+?)(\s[^>]*)?>.*?<\/\1>/gs
// Matches self-closing tags: <tagName .../>
const XML_SELF_CLOSING_PATTERN = /<(\w+?)(\s[^>]*)?\/>/g
// Opening tags only — catches partial/malformed: <tag ...>
export const XML_OPENING_TAG_PATTERN = /<(\w+?)(\s[^>]*)?>/g
// Closing tags only: </tag>
export const XML_CLOSING_TAG_PATTERN = /<\/(\w+?)>/g
// Malformed patterns — catches Qwen-style: <tag, <tag=, etc. (no closing >)
// Stops at < (start of another tag) to avoid consuming across tag boundaries
export const XML_MALFORMED_PATTERN = /<\/?(\w+)\s*(?:[^><]{0,20})?(?![^<]*>)/g

export interface ModelSpecificThresholds {
  qwen: {
    repetitionThreshold: number
    maxToolInputTokens: number
    partialTagThreshold: number
  }
}

export interface XmlRepetitionConfig {
  repetitionThreshold: number
  windowSize: number
  maxToolInputTokens: number
  maxTotalTokens: number
  // Threshold for partial/incomplete tags (more sensitive — default 2)
  partialTagThreshold?: number
  // Model ID for model-specific threshold overrides
  modelId?: string
  // Model-specific threshold configuration
  modelSpecificThresholds?: ModelSpecificThresholds
  // Multiplier for XML content token estimation (more conservative — default 1.5)
  xmlTokenEstimationMultiplier?: number
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

type TagCompleteness = "complete" | "partial" | "prefix"

interface TagEntry {
  tagName: string
  fingerprint: string
  completeness: TagCompleteness
}

export class XmlRepetitionDetector {
  private config: XmlRepetitionConfig
  private modelId: string | undefined
  private tagWindow: TagEntry[] = []
  private currentToolTokens: number = 0
  private totalTokens: number = 0

  constructor(config: XmlRepetitionConfig) {
    this.config = config
    this.modelId = config.modelId
  }

  // Returns effective thresholds — qwen overrides when modelId contains "qwen" (case-insensitive)
  private getEffectiveThresholds() {
    const isQwen = this.modelId?.toLowerCase().includes("qwen") ?? false
    if (isQwen && this.config.modelSpecificThresholds?.qwen) {
      const qwen = this.config.modelSpecificThresholds.qwen
      return {
        repetitionThreshold: qwen.repetitionThreshold,
        maxToolInputTokens: qwen.maxToolInputTokens,
        partialTagThreshold: qwen.partialTagThreshold,
      }
    }
    return {
      repetitionThreshold: this.config.repetitionThreshold,
      maxToolInputTokens: this.config.maxToolInputTokens,
      partialTagThreshold: this.config.partialTagThreshold ?? 2,
    }
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

  consumeDelta(_toolName: string, text: string, _tokens?: number): RepetitionDetected | undefined {
    const thresholds = this.getEffectiveThresholds()
    const multiplier = this.config.xmlTokenEstimationMultiplier ?? 1.5

    // XML-aware token estimation (sole source of truth — no external tokens needed)
    const effectiveTokens = this.estimateTokens(text, multiplier)

    // Accumulate tokens
    this.currentToolTokens += effectiveTokens
    this.totalTokens += effectiveTokens

    // Check per-tool token limit
    if (this.currentToolTokens > thresholds.maxToolInputTokens) {
      log.info("XmlRepetitionDetector — per-tool token limit exceeded", {
        tool: _toolName,
        tokens: this.currentToolTokens,
        limit: thresholds.maxToolInputTokens,
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
    if (this.totalTokens > this.config.maxTotalTokens) {
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

    const partialThreshold = thresholds.partialTagThreshold

    // Extract complete and partial tags (opening/closing pairs, opening-only, closing-only)
    const tags = this.extractTags(text)
    for (const entry of tags) {
      this.processTag(entry)
      // Log partial tag detection for diagnostics
      if (entry.completeness !== "complete") {
        const count = this.countByTag(entry.tagName)
        log.debug("XmlRepetitionDetector — partial tag detected", {
          tagName: entry.tagName,
          completeness: entry.completeness,
          count,
        })
      }
      // Complete tags use repetitionThreshold; partial tags use partialTagThreshold
      const threshold = entry.completeness === "complete" ? thresholds.repetitionThreshold : partialThreshold
      const detection = this.checkRepetition(threshold)
      if (detection) {
        return detection
      }
    }

    // Also extract and process prefix tags with partial threshold
    const prefixes = this.extractTagPrefixes(text)
    for (const entry of prefixes) {
      this.processTag(entry)
      const count = this.countByTag(entry.tagName)
      log.debug("XmlRepetitionDetector — prefix tag detected", {
        tagName: entry.tagName,
        completeness: entry.completeness,
        count,
      })
      const detection = this.checkRepetition(partialThreshold)
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

  private extractTags(text: string): TagEntry[] {
    const tags: TagEntry[] = []

    // Track character ranges covered by complete tags (to avoid double-counting as partial)
    const coveredRanges: Array<[number, number]> = []

    const addRange = (start: number, end: number) => {
      coveredRanges.push([start, end])
    }

    const isCovered = (pos: number): boolean => {
      for (const [start, end] of coveredRanges) {
        if (pos >= start && pos <= end) return true
      }
      return false
    }

    // Extract opening/closing pairs — complete tags
    let match: RegExpExecArray | null
    const tagRegex = new RegExp(XML_TAG_PATTERN)
    while ((match = tagRegex.exec(text)) !== null) {
      const tagName = match[1].toLowerCase()
      addRange(match.index, match.index + match[0].length - 1)
      tags.push({ tagName, fingerprint: this.fnv1a(tagName), completeness: "complete" })
    }

    // Extract self-closing tags — complete tags
    const selfClosingRegex = new RegExp(XML_SELF_CLOSING_PATTERN)
    while ((match = selfClosingRegex.exec(text)) !== null) {
      const tagName = match[1].toLowerCase()
      addRange(match.index, match.index + match[0].length - 1)
      tags.push({ tagName, fingerprint: this.fnv1a(tagName), completeness: "complete" })
    }

    // Extract opening-only tags (not part of a complete pair) — partial tags
    const openingRegex = new RegExp(XML_OPENING_TAG_PATTERN)
    while ((match = openingRegex.exec(text)) !== null) {
      if (isCovered(match.index)) continue
      const tagName = match[1].toLowerCase()
      tags.push({ tagName, fingerprint: this.fnv1a(tagName), completeness: "partial" })
    }

    // Extract closing-only tags (not part of a complete pair) — partial tags
    const closingRegex = new RegExp(XML_CLOSING_TAG_PATTERN)
    while ((match = closingRegex.exec(text)) !== null) {
      if (isCovered(match.index)) continue
      const tagName = match[1].toLowerCase()
      tags.push({ tagName, fingerprint: this.fnv1a(tagName), completeness: "partial" })
    }

    return tags
  }

  // Extracts tag prefixes from malformed/incomplete XML (no closing >)
  // Uses XML_MALFORMED_PATTERN to catch Qwen-style: <parameter, <parameter=, etc.
  private extractTagPrefixes(text: string): TagEntry[] {
    const tags: TagEntry[] = []

    let match: RegExpExecArray | null
    const malformedRegex = new RegExp(XML_MALFORMED_PATTERN)
    while ((match = malformedRegex.exec(text)) !== null) {
      const tagName = match[1].toLowerCase()
      tags.push({ tagName, fingerprint: this.fnv1a(tagName), completeness: "prefix" })
    }

    return tags
  }

  private processTag(entry: TagEntry): void {
    // Normalize: lowercase (already done in extraction), collapse whitespace
    const normalized = entry.tagName.toLowerCase().replace(/\s+/g, "")

    // Add to sliding window (use entry's fingerprint and completeness)
    this.tagWindow.push({ ...entry, tagName: normalized })

    // Maintain window size
    if (this.tagWindow.length > this.config.windowSize) {
      this.tagWindow.shift()
    }
  }

  // Count occurrences of a tag name in the current window (by fingerprint)
  private countByTag(tagName: string): number {
    const fp = this.fnv1a(tagName)
    let count = 0
    for (const entry of this.tagWindow) {
      if (entry.fingerprint === fp) count++
    }
    return count
  }

  private checkRepetition(threshold: number): RepetitionDetected | undefined {
    // Count occurrences of each fingerprint in the window
    const counts = new Map<string, number>()
    const nameByFp = new Map<string, string>()
    for (const entry of this.tagWindow) {
      counts.set(entry.fingerprint, (counts.get(entry.fingerprint) ?? 0) + 1)
      nameByFp.set(entry.fingerprint, entry.tagName)
    }

    for (const [fp, count] of counts) {
      if (count >= threshold) {
        const tagName = nameByFp.get(fp) ?? "unknown"
        log.info("XmlRepetitionDetector — repetition detected", {
          tagName,
          count,
          threshold,
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

  // XML-aware token estimation: applies multiplier when text contains both < and >
  private estimateTokens(text: string, multiplier: number): number {
    const isXml = text.includes("<") && text.includes(">")
    const base = text.length / 4
    if (isXml) {
      return Math.ceil(base * multiplier)
    }
    return Math.ceil(base)
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

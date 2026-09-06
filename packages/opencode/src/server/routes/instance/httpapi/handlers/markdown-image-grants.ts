import * as fsPromises from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import * as nodePath from "node:path"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  KIND_BY_EXTENSION,
  MARKDOWN_IMAGE_GRANT_TTL_MS,
  MARKDOWN_MEDIA_MAX_BYTES,
  MarkdownImageGrantsPayload,
  MAX_IMAGE_GRANT_PATHS_PER_MESSAGE,
} from "../groups/markdown-image-grants"
import { MessageNotFoundError } from "../errors"

// Grant store - module-level Map with TTL pruning
type Grant = {
  canonicalPath: string
  scopes: Set<string>
  expiresAt: number
}

const outsideFileGrants = new Map<string, Grant>()

function pruneOutsideFileGrants() {
  const now = Date.now()
  for (const [token, grant] of outsideFileGrants.entries()) {
    if (!grant || grant.expiresAt <= now) {
      outsideFileGrants.delete(token)
    }
  }
}

// Ported from better-openchamber/packages/web/server/lib/fs/routes.js
async function mintOutsideFileGrant(targetPath: string, opts: { scopes: string[] }) {
  const raw = typeof targetPath === "string" ? targetPath.trim() : ""
  if (!raw) {
    throw new Error("Path is required")
  }
  const canonicalPath = await fsPromises.realpath(raw)
  const stats = await fsPromises.stat(canonicalPath)
  if (!stats.isFile()) {
    throw new Error("Outside file grants require a file path")
  }
  pruneOutsideFileGrants()
  const token = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const normalizedScopes = new Set(
    (Array.isArray(opts.scopes) ? opts.scopes : [])
      .filter((scope) => typeof scope === "string" && scope.trim())
      .map((scope) => scope.trim()),
  )
  if (normalizedScopes.size === 0) {
    normalizedScopes.add("read")
  }
  const grant: Grant = {
    canonicalPath,
    scopes: normalizedScopes,
    expiresAt: Date.now() + MARKDOWN_IMAGE_GRANT_TTL_MS,
  }
  outsideFileGrants.set(token, grant)
  return {
    path: canonicalPath,
    outsideFileGrant: token,
    expiresAt: grant.expiresAt,
  }
}

// Markdown source extraction helpers
// Ported from better-openchamber/packages/web/server/lib/markdown-image-grants/routes.js

const asString = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

const isWithin = (target: string, root: string): boolean => {
  const relative = nodePath.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative))
}

const parseFileSource = (source: string): string => {
  if (/^file:\/\//i.test(source)) {
    try {
      const url = new URL(source)
      if (url.protocol !== "file:" || (url.host && url.host !== "localhost")) return ""
      const pathname = decodeURIComponent(url.pathname)
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname
    } catch {
      return ""
    }
  }
  const pathname = source.split(/[?#]/, 1)[0] || ""
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

const hasImageSignature = (bytes: Buffer | Uint8Array): boolean => {
  if (bytes.length >= 8) {
    // PNG signature
    if (
      bytes[0] === 0x89 &&
      bytes.subarray(1, 4).toString("ascii") === "PNG" &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return true
    }
    // JPEG signature
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return true
    }
  }
  const header = bytes.subarray(0, 12).toString("ascii")
  return (
    header.startsWith("GIF87a") ||
    header.startsWith("GIF89a") ||
    (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP")
  )
}

const hasMediaSignatureForKind = (bytes: Buffer | Uint8Array, kind: string): boolean => {
  const header = bytes.subarray(0, 12).toString("ascii")
  if (kind === "image") return hasImageSignature(bytes)
  if (kind === "video") {
    return (
      header.slice(4, 8) === "ftyp" ||
      (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    )
  }
  if (kind === "audio") {
    return (
      header.startsWith("ID3") ||
      (header.startsWith("RIFF") && header.slice(8, 12) === "WAVE") ||
      header.slice(4, 8) === "ftyp"
    )
  }
  return false
}

const classifyMediaKind = (source: string): "image" | "video" | "audio" | undefined => {
  const pathname = asString(source).split(/[?#]/, 1)[0] || ""
  const extension = pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  return extension ? KIND_BY_EXTENSION[extension] : undefined
}

const normalizeReferenceLabel = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase()

const unescapeMarkdownDestination = (value: string) =>
  value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, "$1")

const isEscapedAt = (value: string, index: number): boolean => {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashes += 1
  }
  return slashes % 2 === 1
}

const findClosingBracket = (value: string, start: number): number => {
  for (let cursor = start; cursor < value.length; cursor += 1) {
    if (value[cursor] === "]" && !isEscapedAt(value, cursor)) return cursor
  }
  return -1
}

const findInlineImageEnd = (value: string, start: number): number => {
  let cursor = start
  while (/\s/.test(value[cursor] || "")) cursor += 1
  if (value[cursor] === ")") return cursor

  const opener = value[cursor]
  const closer = opener === '"' ? '"' : opener === "'" ? "'" : opener === "(" ? ")" : ""
  if (!closer) return -1
  cursor += 1
  for (; cursor < value.length; cursor += 1) {
    if (value[cursor] !== closer || isEscapedAt(value, cursor)) continue
    cursor += 1
    while (/\s/.test(value[cursor] || "")) cursor += 1
    return value[cursor] === ")" ? cursor : -1
  }
  return -1
}

const parseInlineDestination = (value: string, start: number): { source: string; end: number } | null => {
  let cursor = start
  while (/\s/.test(value[cursor] || "")) cursor += 1
  if (value[cursor] === "<") {
    const end = value.indexOf(">", cursor + 1)
    if (end < 0) return null
    const imageEnd = findInlineImageEnd(value, end + 1)
    return imageEnd < 0
      ? null
      : { source: unescapeMarkdownDestination(value.slice(cursor + 1, end)), end: imageEnd }
  }

  let source = ""
  let depth = 0
  for (; cursor < value.length; cursor += 1) {
    const char = value[cursor]
    if (char === "\\" && cursor + 1 < value.length) {
      source += char + value[cursor + 1]
      cursor += 1
      continue
    }
    if (char === "(") {
      depth += 1
      source += char
      continue
    }
    if (char === ")") {
      if (depth === 0) return { source: unescapeMarkdownDestination(source), end: cursor }
      depth -= 1
      source += char
      continue
    }
    if (/\s/.test(char) && depth === 0) {
      const imageEnd = findInlineImageEnd(value, cursor)
      return imageEnd < 0 ? null : { source: unescapeMarkdownDestination(source), end: imageEnd }
    }
    source += char
  }
  return null
}

const parseDefinitionDestination = (value: string): string => {
  const trimmed = value.trimStart()
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">", 1)
    return end < 0 ? "" : unescapeMarkdownDestination(trimmed.slice(1, end))
  }
  const match = /^(?:\\.|\S)+/.exec(trimmed)
  return match ? unescapeMarkdownDestination(match[0]) : ""
}

const collectMarkdownLinesOutsideCode = (message: { parts?: Array<{ type?: string; text?: string }> }): string[] => {
  const lines: string[] = []
  const parts = Array.isArray(message?.parts) ? message.parts : []
  for (const part of parts) {
    if (part?.type !== "text" || typeof part.text !== "string") continue
    let fence: { char: string; size: number } | null = null
    for (const line of part.text.split("\n")) {
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (fenceMatch) {
        const marker = fenceMatch[1]!
        if (!fence) {
          fence = { char: marker[0]!, size: marker.length }
        } else if (marker[0] === fence.char && marker.length >= fence.size) {
          fence = null
        }
        continue
      }
      if (fence) continue
      lines.push(line.replace(/`+[^`]*`+/g, ""))
    }
  }
  return lines
}

const markdownImageSources = (message: { parts?: Array<{ type?: string; text?: string }> }): Set<string> => {
  const sources = new Set<string>()
  const markdownLines = collectMarkdownLinesOutsideCode(message)
  const definitions = new Map<string, string>()
  for (const line of markdownLines) {
    const match = /^\s{0,3}\[([^\]]+)]\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const source = parseDefinitionDestination(match[2]!)
    if (source) definitions.set(normalizeReferenceLabel(match[1]!), source)
  }

  for (const line of markdownLines) {
    for (let cursor = 0; cursor < line.length; cursor += 1) {
      if (line[cursor] !== "!" || line[cursor + 1] !== "[" || isEscapedAt(line, cursor)) continue
      const altEnd = findClosingBracket(line, cursor + 2)
      if (altEnd < 0) continue
      const alt = line.slice(cursor + 2, altEnd)
      const next = line[altEnd + 1]
      if (next === "(") {
        const parsed = parseInlineDestination(line, altEnd + 2)
        if (parsed?.source) sources.add(parsed.source)
        cursor = parsed?.end ?? altEnd
        continue
      }
      let label = alt
      if (next === "[") {
        const labelEnd = findClosingBracket(line, altEnd + 2)
        if (labelEnd < 0) continue
        label = line.slice(altEnd + 2, labelEnd) || alt
        cursor = labelEnd
      } else {
        cursor = altEnd
      }
      const source = definitions.get(normalizeReferenceLabel(label))
      if (source) sources.add(source)
    }
  }
  return sources
}

// Media source inspection
// Ported from better-openchamber/packages/web/server/lib/markdown-image-grants/routes.js
// Containment always relaxed - no workspace-root check

const inspectMediaSource = async (input: {
  source: string
  directory: string
}): Promise<{ status: "ready" | "missing" | "error"; path?: string; outsideWorkspace?: boolean }> => {
  const { source, directory } = input
  const parsed = parseFileSource(source)
  if (!parsed) return { status: "error" }
  const kind = classifyMediaKind(parsed)
  if (!kind) return { status: "error" }
  const sourcePath = nodePath.isAbsolute(parsed) ? parsed : nodePath.resolve(directory, parsed)
  const workspaceRoot = nodePath.resolve(directory)
  const outsideWorkspace = !isWithin(nodePath.resolve(sourcePath), workspaceRoot)

  try {
    const canonicalPath = await fsPromises.realpath(sourcePath)
    const handle = await fsPromises.open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > MARKDOWN_MEDIA_MAX_BYTES[kind]) {
        return { status: "error" }
      }
      const header = Buffer.alloc(12)
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      if (!hasMediaSignatureForKind(header.subarray(0, bytesRead), kind)) {
        return { status: "error" }
      }
      return {
        status: "ready",
        path: outsideWorkspace ? canonicalPath : nodePath.resolve(sourcePath),
        outsideWorkspace,
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: string }).code
      if (code === "ENOENT") return { status: "missing" }
      if (code === "EACCES" || code === "EPERM" || code === "ELOOP") {
        return { status: "error" }
      }
    }
    throw error
  }
}

export const markdownImageGrantsHandlers = HttpApiBuilder.group(
  InstanceHttpApi,
  "markdown-image-grants",
  (handlers) =>
    Effect.gen(function* () {
      const session = yield* Session.Service

      const grants = Effect.fn("MarkdownImageGrantsHttpApi.grants")(function* (ctx: {
        params: { sessionID: SessionID }
        payload: typeof MarkdownImageGrantsPayload.Type
      }) {
        const { sessionID } = ctx.params
        const { directory, messageId: rawMessageId, sources } = ctx.payload
        const messageId = rawMessageId as MessageID

        // Validate inputs
        if (!directory || !messageId || sources.length === 0 || sources.length > MAX_IMAGE_GRANT_PATHS_PER_MESSAGE) {
          return yield* new HttpApiError.BadRequest({})
        }

        // Authority check - get the message
        const message = yield* MessageV2.get({ sessionID, messageID: messageId }).pipe(
          Effect.catchTag("NotFoundError", () =>
            Effect.fail(
              new MessageNotFoundError({
                sessionID,
                messageID: messageId,
                message: "Assistant message not found",
              }),
            ),
          ),
        )

        // Verify message ID and role
        if (message.info.id !== messageId || message.info.role !== "assistant") {
          return yield* new MessageNotFoundError({
            sessionID,
            messageID: messageId,
            message: "Assistant message not found",
          })
        }

        // Get referenced sources from assistant message text
        const referenced = markdownImageSources(message)
        const results: Array<{
          source: string
          status: "ready" | "missing" | "error"
          path?: string
          outsideFileGrant?: string
          expiresAt?: number
        }> = []

        for (const source of sources) {
          if (!referenced.has(source)) {
            results.push({ source, status: "error" })
            continue
          }
          try {
            const inspected = yield* Effect.promise(() => inspectMediaSource({ source, directory }))
            if (inspected.status !== "ready") {
              results.push({ source, status: inspected.status })
              continue
            }
            if (inspected.outsideWorkspace) {
              const grant = yield* Effect.promise(() =>
                mintOutsideFileGrant(inspected.path!, { scopes: ["raw"] }),
              )
              results.push({
                source,
                status: "ready",
                path: inspected.path,
                outsideFileGrant: grant.outsideFileGrant,
                expiresAt: grant.expiresAt,
              })
            } else {
              results.push({
                source,
                status: "ready",
                path: inspected.path,
              })
            }
          } catch {
            results.push({ source, status: "error" })
          }
        }

        return { results }
      })

      return handlers.handle("grants", grants)
    }),
)

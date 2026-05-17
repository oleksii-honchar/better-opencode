import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, extname } from "node:path"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "session.attachment" })

const ATTACHMENTS_DIR = join(tmpdir(), "opencode-attachments")
const REGISTRY_FILE = join(ATTACHMENTS_DIR, ".registry.json")

interface Registry {
  [messageID: string]: string[] // file paths
}

function ensureDir() {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true })
}

function loadRegistry(): Registry {
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf8"))
  } catch {
    return {}
  }
}

function saveRegistry(registry: Registry) {
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry), "utf8")
}

/**
 * Stores a data URL as a temp file and returns the opencode://attachment URI.
 *
 * @param dataUrl - Full data URL (e.g. "data:image/png;base64,iVBORw0...")
 * @param originalFilename - Original filename for extension extraction
 * @returns { uri: string, path: string }
 */
export function store(dataUrl: string, originalFilename?: string): { uri: string; path: string } {
  ensureDir()

  // Extract base64 from data URL
  const commaIndex = dataUrl.indexOf(",")
  if (commaIndex === -1) throw new Error("Invalid data URL")
  const header = dataUrl.slice(0, commaIndex)
  const base64Data = dataUrl.slice(commaIndex + 1)

  // Determine extension from original filename or MIME type
  let ext = ".bin"
  if (originalFilename) {
    ext = extname(originalFilename) || ext
  } else {
    // Parse MIME type from data URL header: "data:image/png;base64" → ".png"
    const mimeMatch = header.match(/data:(\w+\/(\w+))/)
    if (mimeMatch?.[2]) {
      ext = "." + mimeMatch[2]
    }
  }

  // Generate UUID-based filename
  const uuid = randomUUID()
  const filename = `${uuid}${ext}`
  const path = join(ATTACHMENTS_DIR, filename)

  // Write file
  writeFileSync(path, Buffer.from(base64Data, "base64"))

  const uri = `opencode://attachment/${filename}`

  log.debug("stored attachment", { uri, path, ext })

  return { uri, path }
}

/**
 * Resolves an opencode://attachment URI to base64 string.
 * Reads the temp file and returns its base64-encoded content.
 *
 * @param uri - The opencode://attachment/<uuid>.<ext> URI
 * @returns Base64-encoded file content, or undefined if not found
 */
export function resolve(uri: string): string | undefined {
  // Extract filename from URI: "opencode://attachment/abc.png" → "abc.png"
  const match = uri.match(/^opencode:\/\/attachment\/(.+)$/)
  if (!match) return undefined

  const filename = match[1]
  const path = join(ATTACHMENTS_DIR, filename)

  try {
    const buffer = readFileSync(path)
    log.debug("resolved attachment", { uri, size: buffer.length })
    return buffer.toString("base64")
  } catch {
    log.warn("attachment not found on disk", { uri, path })
    return undefined // file not found or unreadable
  }
}

/**
 * Tracks a file path for cleanup at session end.
 *
 * @param messageID - The message ID to group files under
 * @param filePath - Absolute path to the temp file
 */
export function trackForMessage(messageID: string, filePath: string): void {
  ensureDir()
  const registry = loadRegistry()
  if (!registry[messageID]) registry[messageID] = []
  registry[messageID].push(filePath)
  saveRegistry(registry)
  log.debug("tracked attachment for cleanup", { messageID, filePath })
}

/**
 * Checks if a message has tracked attachments.
 *
 * @param messageID - The message ID to check
 * @returns true if the message has one or more tracked attachments
 */
export function hasAttachments(messageID: string): boolean {
  const registry = loadRegistry()
  return (registry[messageID]?.length ?? 0) > 0
}

/**
 * Removes all temp files for a given message ID.
 * Called when a session/message is cleaned up.
 *
 * @param messageID - The message ID to clean up attachments for
 */
export function cleanup(messageID: string): void {
  const registry = loadRegistry()
  const files = registry[messageID] || []

  if (files.length === 0) {
    return
  }

  for (const filePath of files) {
    try {
      unlinkSync(filePath)
      log.debug("cleaned up attachment", { messageID, filePath })
    } catch {
      // file already gone, ignore
      log.debug("attachment already removed", { messageID, filePath })
    }
  }
  delete registry[messageID]
  saveRegistry(registry)
  log.debug("cleanup complete", { messageID, removedCount: files.length })
}

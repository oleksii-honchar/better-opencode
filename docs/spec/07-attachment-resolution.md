# Attachment Resolution — Technical Specification

## Overview

Enable the LLM to pass attached file data as tool arguments (e.g., to `extract_bytes`). Currently, vision models can *see* images but cannot *extract* base64 data to construct tool call arguments. The fix stores attachments as temp files with resolvable URIs and intercepts MCP tool execution to inject base64.

**Status:** Implemented

### Current Flow (Broken)

```
User attaches image → FilePart(data URL) → LLM sees image visually
→ LLM calls extract_bytes(data: ???) — no base64 available
→ Tool receives empty/invalid data → failure
```

### Target Flow (Fixed)

```
User attaches image → resolvePart stores temp file + generates URI
→ Prompt includes: FilePart(visual) + synthetic text("Attached: photo.png (opencode://attachment/abc123.png)")
→ LLM calls extract_bytes(data: "opencode://attachment/abc123.png")
→ convertMcpTool intercepts, resolves URI → base64
→ Tool receives valid base64 → success
```

## Architecture Diagram

```
┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐
│  User Input  │    │  resolvePart     │    │  LLM + Prompt    │    │ MCP Tool     │
│  (attach)    │───▶│  (store + inject)│───▶│  (sees URI text) │───▶│  (calls w/   │
└─────────────┘    └──────────────────┘    └──────────────────┘    │   URI arg)    │
                                                                    └──────┬───────┘
                                                                           │
                                                                    ┌──────▼───────┐
                                                                    │ convertMcpTool│
                                                                    │ (intercept + │
                                                                    │  resolve URI) │
                                                                    └──────┬───────┘
                                                                           │
                                                                    ┌──────▼───────┐
                                                                    │ client.callTool│
                                                                    │ (base64 data) │
                                                                    └──────────────┘
```

## Technology Stack

| Component | Technology | Justification |
|-----------|-----------|---------------|
| UUID generation | `crypto.randomUUID()` | Built-in Node.js, no dependency |
| File I/O | `fs` (sync) | Simple operations, no async needed at store/resolve time |
| Temp directory | `os.tmpdir()` | OS-managed cleanup, no manual management |
| URI scheme | `opencode://attachment/<uuid>.<ext>` | Self-contained — filename encodes extension, no registry needed for resolution |

## Components

### 1. Attachment Store Module

**File:** `packages/opencode/src/session/attachment.ts`

New module with four functions:

```ts
/**
 * Stores a data URL as a temp file and returns the opencode://attachment URI.
 */
export function store(dataUrl: string, originalFilename?: string): { uri: string; path: string }

/**
 * Resolves an opencode://attachment URI to base64 string.
 */
export function resolve(uri: string): string | undefined

/**
 * Tracks a file path for cleanup under a message ID.
 */
export function trackForMessage(messageID: string, filePath: string): void

/**
 * Removes all temp files for a given message ID.
 */
export function cleanup(messageID: string): void
```

**Implementation details:**

- **Storage path:** `{os.tmpdir()}/opencode-attachments/{uuid}.{ext}`
  - e.g., `/var/folders/xx/opencode-attachments/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png`
- **UUID-based filename with original extension** — no separate ID→file mapping needed for resolution
- **Directory creation:** `mkdirSync(dir, { recursive: true })` on first store
- **File tracking per message:** `{os.tmpdir()}/opencode-attachments/.registry.json` — maps messageID → file paths (for cleanup only)
- **URI format:** `opencode://attachment/{uuid}.{ext}`

**store() implementation:**
```ts
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, extname } from "node:path"

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

  return { uri, path }
}
```

**resolve() implementation:**
```ts
export function resolve(uri: string): string | undefined {
  // Extract filename from URI: "opencode://attachment/abc.png" → "abc.png"
  const match = uri.match(/^opencode:\/\/attachment\/(.+)$/)
  if (!match) return undefined

  const filename = match[1]
  const path = join(ATTACHMENTS_DIR, filename)

  try {
    const buffer = readFileSync(path)
    return buffer.toString("base64")
  } catch {
    return undefined // file not found or unreadable
  }
}
```

**trackForMessage() and cleanup() implementation:**
```ts
export function trackForMessage(messageID: string, filePath: string) {
  ensureDir()
  const registry = loadRegistry()
  if (!registry[messageID]) registry[messageID] = []
  registry[messageID].push(filePath)
  saveRegistry(registry)
}

export function cleanup(messageID: string): void {
  const registry = loadRegistry()
  const files = registry[messageID] || []
  for (const filePath of files) {
    try {
      unlinkSync(filePath)
    } catch {
      // file already gone, ignore
    }
  }
  delete registry[messageID]
  saveRegistry(registry)
}
```

### 2. resolvePart Integration

**File:** `packages/opencode/src/session/prompt.ts`

In the `resolvePart` function, non-text data URLs (images, media) are stored as temp files and a synthetic text part with the URI reference is injected into the prompt.

```ts
case "data:":
  if (part.mime === "text/plain") {
    // existing text/plain path — inline base64 text
    // ...
  }
  // For image/media files: store as temp file + inject URI reference
  const { uri, path: filePath } = storeAttachment(part.url, part.filename)
  trackAttachmentForMessage(info.id, filePath)
  return [
    {
      messageID: info.id,
      sessionID: input.sessionID,
      type: "text",
      synthetic: true,
      text: `Attached file: ${part.filename ?? "unnamed"} (${uri})`,
    },
    { ...part, messageID: info.id, sessionID: input.sessionID }, // FilePart for visual input
  ]
```

**Key design:** Returns **both** a synthetic text part (for the LLM to see the URI) and the original FilePart (for vision models to see the image). The LLM can reference the URI in tool call arguments.

### 3. convertMcpTool Interception

**File:** `packages/opencode/src/mcp/index.ts`

In the `convertMcpTool` function, tool arguments are intercepted and `opencode://attachment/` URIs are resolved to base64 before forwarding to the MCP client.

```ts
execute: async (args: unknown) => {
  const resolvedArgs = resolveAttachmentUris(args)
  return client.callTool(
    { name: mcpTool.name, arguments: (resolvedArgs || {}) as Record<string, unknown> },
    CallToolResultSchema,
    { resetTimeoutOnProgress: true, timeout },
  )
}
```

**resolveAttachmentUris() implementation:** Recursively walks the entire args tree (objects, arrays, strings), resolving any `opencode://attachment/` URIs to base64. Unresolvable URIs are passed through as-is (the tool handles the error).

```ts
function resolveAttachmentUris(args: unknown): unknown {
  if (typeof args === "string") {
    const match = args.match(/^opencode:\/\/attachment\/.+$/)
    if (match) {
      const base64 = resolveAttachment(args)
      if (base64 !== undefined) return base64
    }
    return args // unresolvable URI or plain string — pass through
  }
  if (Array.isArray(args)) {
    return args.map(resolveAttachmentUris)
  }
  if (args && typeof args === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      result[key] = resolveAttachmentUris(value)
    }
    return result
  }
  return args // null, boolean, number — pass through
}
```

### 4. Cleanup Lifecycle

**File:** `packages/opencode/src/session/prompt.ts`

Cleanup is called **after the LLM loop completes** (not as a finalizer in `createUserMessage`, which would fire before tool calls):

```ts
const result =
  input.noReply === true ? message : yield* loop({ sessionID: input.sessionID })
// Cleanup attachments AFTER the LLM loop completes — temp files are needed during
// tool calls for URI resolution, so we can't clean up in createUserMessage's scope.
cleanupAttachments(message.info.id)
return result
```

**Critical lifecycle detail:** The cleanup must happen after `loop()` returns because the LLM may make multiple tool calls across loop iterations. If cleanup fires when `createUserMessage`'s scope closes (before `loop()`), temp files are deleted while still needed for URI resolution.

## Data Models

### URI Format

```
opencode://attachment/{uuid}.{ext}
```

- **uuid:** `randomUUID()` — 128-bit UUID, negligible collision risk
- **ext:** Original file extension (from filename or MIME type), fallback to `.bin`

**Examples:**
- `opencode://attachment/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png`
- `opencode://attachment/f0e1d2c3-b4a5-6789-fedc-ba9876543210.pdf`

### Registry File

```json
{
  "msg_abc123": [
    "/var/folders/xx/opencode-attachments/a1b2c3d4.png",
    "/var/folders/xx/opencode-attachments/b2c3d4e5.pdf"
  ],
  "msg_def456": [
    "/var/folders/xx/opencode-attachments/c3d4e5f6.jpg"
  ]
}
```

Located at: `{os.tmpdir()}/opencode-attachments/.registry.json`

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Data URL with no comma (invalid) | `store()` throws `Error("Invalid data URL")` |
| Extension extraction fails (unknown MIME, no filename) | Fallback to `.bin` |
| Temp file already deleted before cleanup | `cleanup()` ignores silently (try/catch around `unlinkSync`) |
| Registry.json doesn't exist | `loadRegistry()` creates empty object |
| Unresolvable URI (file missing during tool call) | `resolveAttachmentUris()` passes through original string, tool handles error |

## Security Considerations

- **Path traversal:** `resolve()` extracts filename from regex match and joins with `ATTACHMENTS_DIR` — cannot escape the temp directory
- **File overwriting:** `randomUUID()` produces 128-bit UUIDs — negligible collision risk
- **Registry file permissions:** Inherits OS defaults (not a concern for local temp files)
- **Atomic registry writes:** Single `writeFileSync` — crash mid-write could corrupt registry, but worst case is orphaned temp files (OS cleans eventually)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Temp file not cleaned up | Disk space leak | Cleanup called after loop; OS also cleans tmpdir on reboot |
| Registry corruption | Orphaned temp files | `loadRegistry()` returns `{}` on parse error — safe degradation |
| Extension mismatch (e.g., `.bin` instead of `.png`) | Tool may reject file | MIME type parsing from data URL header provides fallback |
| Cleanup fires too early | Tool calls fail with missing files | Cleanup moved to after `loop()`, not in `createUserMessage` scope |

## Files Changed

| File | Change |
|------|--------|
| `packages/opencode/src/session/attachment.ts` | New — store, resolve, trackForMessage, cleanup |
| `packages/opencode/src/session/prompt.ts` | Modified — resolvePart integration + cleanup after loop |
| `packages/opencode/src/mcp/index.ts` | Modified — convertMcpTool URI resolution |

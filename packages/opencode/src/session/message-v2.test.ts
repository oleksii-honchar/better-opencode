import { describe, test, expect } from "bun:test"
import type { ModelMessage } from "ai"
import {
  repairOrphanedToolResults,
  countAssemblyParts,
  SYNTHETIC_ATTACHMENT_PROMPT,
  toModelMessages,
  type FilePart,
} from "@/session/message-v2"
import { WithParts } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import type { Provider } from "@/provider/provider"

// ---------------------------------------------------------------------------
// Hand-built fixtures — minimal but realistic ModelMessage shapes derived
// from @ai-sdk/provider-utils@4.0.21 ToolModelMessage / AssistantModelMessage
// types. No mocks of the AI SDK. Assertions check the returned array shape.
// ---------------------------------------------------------------------------

function makeAssistantToolCall(toolCallId: string, toolName = "read"): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName,
        input: {},
      },
    ],
  }
}

function makeAssistantText(text: string): ModelMessage {
  return { role: "assistant", content: text }
}

function makeToolResult(toolCallId: string, toolName = "read", outputText = "ok"): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "text", value: outputText },
      },
    ],
  }
}

function makeUserText(text: string): ModelMessage {
  return { role: "user", content: text }
}

describe("repairOrphanedToolResults", () => {
  // ---- Case 1: paired tool-call + tool-result → preserved ----
  test("preserves a paired tool-call and tool-result", () => {
    const input: ModelMessage[] = [makeAssistantToolCall("call_1"), makeToolResult("call_1")]
    const result = repairOrphanedToolResults(input)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(input[0])
    expect(result[1]).toEqual(input[1])
  })

  test("preserves a paired tool-call when the tool message follows several assistant messages", () => {
    const input: ModelMessage[] = [
      makeAssistantText("Hello"),
      makeAssistantToolCall("call_abc"),
      makeUserText("after tool"),
      makeToolResult("call_abc"),
    ]
    const result = repairOrphanedToolResults(input)

    expect(result).toHaveLength(4)
    expect(result).toEqual(input)
  })

  // ---- Case 2: orphan tool-result (no matching tool-call anywhere) → removed ----
  test("drops an orphan tool-result whose toolCallId has no matching tool-call", () => {
    const input: ModelMessage[] = [makeAssistantText("hi"), makeToolResult("call_orphan")]
    const result = repairOrphanedToolResults(input)

    expect(result).toHaveLength(1)
    // The orphan tool message must be gone
    expect(result.some((m) => m.role === "tool")).toBe(false)
    // The assistant text is preserved
    expect(result[0]).toEqual(input[0])
  })

  test("drops the orphan even when the assistant has other unrelated tool-calls", () => {
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_a"),
      makeToolResult("call_a"),
      makeToolResult("call_orphan_no_match"),
    ]
    const result = repairOrphanedToolResults(input)

    expect(result).toHaveLength(2)
    // No orphan should be in the result
    const toolMessages = result.filter((m) => m.role === "tool")
    expect(toolMessages).toHaveLength(1)
    // The single remaining tool message should be the paired one
    const toolMsg = toolMessages[0]
    expect(Array.isArray(toolMsg.content)).toBe(true)
    if (Array.isArray(toolMsg.content)) {
      const tr = toolMsg.content.find((p) => p.type === "tool-result")
      expect(tr).toBeDefined()
      if (tr && tr.type === "tool-result") {
        expect(tr.toolCallId).toBe("call_a")
      }
    }
  })

  // ---- Case 3: mixed history → only orphan removed, others preserved ----
  test("in mixed history, only the orphan is removed; order is preserved", () => {
    const input: ModelMessage[] = [
      makeUserText("first"),
      makeAssistantText("ack"),
      makeAssistantToolCall("call_x"),
      makeToolResult("call_x"),
      makeUserText("second"),
      makeAssistantToolCall("call_y"),
      makeToolResult("call_y"),
      // orphan inserted in the middle:
      makeToolResult("call_orphan"),
      makeUserText("third"),
      makeAssistantToolCall("call_z"),
      makeToolResult("call_z"),
    ]
    const result = repairOrphanedToolResults(input)

    // 11 in, 1 orphan out → 10 out
    expect(result).toHaveLength(input.length - 1)

    // No tool message in result should carry the orphan id
    for (const msg of result) {
      if (msg.role !== "tool") continue
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          expect(part.toolCallId).not.toBe("call_orphan")
        }
      }
    }

    // Order of remaining messages must equal input order minus the orphan
    const expectedOrder = input.filter(
      (m) =>
        !(
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "tool-result" && p.toolCallId === "call_orphan")
        ),
    )
    expect(result).toEqual(expectedOrder)
  })

  // ---- Case 4: empty input → empty array ----
  test("returns an empty array for empty input", () => {
    const result = repairOrphanedToolResults([])
    expect(result).toEqual([])
    expect(result).toHaveLength(0)
  })

  // ---- Purity / non-mutation ----
  test("does not mutate the input array", () => {
    const input: ModelMessage[] = [makeAssistantToolCall("call_a"), makeToolResult("call_orphan")]
    const before = input.slice()
    const result = repairOrphanedToolResults(input)
    expect(input).toEqual(before)
    expect(input).toHaveLength(2)
    expect(result).toHaveLength(1)
  })

  test("returns a new array reference, not the same one", () => {
    const input: ModelMessage[] = [makeUserText("hi")]
    const result = repairOrphanedToolResults(input)
    expect(result).not.toBe(input)
  })

  // ---- Defensive shape coverage ----
  test("skips assistant messages with string content (no tool-call parts possible)", () => {
    const input: ModelMessage[] = [makeAssistantText("plain string content"), makeToolResult("call_orphan")]
    const result = repairOrphanedToolResults(input)

    // The orphan still gets dropped (no tool-call id found anywhere),
    // and the string-content assistant is preserved.
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(input[0])
  })

  test("does not drop tool messages whose tool-result ids are present in earlier assistant array content", () => {
    const assistant: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool-call", toolCallId: "call_x", toolName: "read", input: {} },
      ],
    }
    const input: ModelMessage[] = [assistant, makeToolResult("call_x")]
    const result = repairOrphanedToolResults(input)

    expect(result).toHaveLength(2)
    expect(result).toEqual(input)
  })

  test("handles a tool message whose content array contains multiple tool-result parts (all must match)", () => {
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_a"),
      makeAssistantToolCall("call_b"),
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_a", toolName: "read", output: { type: "text", value: "a" } },
          { type: "tool-result", toolCallId: "call_b", toolName: "read", output: { type: "text", value: "b" } },
        ],
      },
    ]
    const result = repairOrphanedToolResults(input)
    expect(result).toHaveLength(3)
    expect(result).toEqual(input)
  })

  test("drops a tool message even when only one of its tool-result parts is orphan", () => {
    // Conservative behavior: if any tool-result in a tool message has no
    // matching tool-call, drop the whole tool message. The spec is unambiguous
    // about the goal — eliminate orphan tool-results — and a partial-match
    // tool message is ambiguous to providers.
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_a"),
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_a", toolName: "read", output: { type: "text", value: "a" } },
          { type: "tool-result", toolCallId: "call_orphan", toolName: "read", output: { type: "text", value: "x" } },
        ],
      },
    ]
    const result = repairOrphanedToolResults(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(input[0])
  })

  test("does not drop non-tool-role messages regardless of orphan status", () => {
    // A user message is never an orphan target. Only role === "tool" matters.
    const input: ModelMessage[] = [makeUserText("hello"), makeToolResult("call_orphan")]
    const result = repairOrphanedToolResults(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(input[0])
  })
})

// ---------------------------------------------------------------------------
// countAssemblyParts — diagnostic counter for the env-gated debug log inside
// `toModelMessagesEffect`. The function must be pure and count:
//   - toolCallCount: tool-call parts in assistant messages with array content
//   - toolResultCount: tool-result parts in tool messages with array content
//   - orphanCount: tool messages removed by repairOrphanedToolResults
// ---------------------------------------------------------------------------

describe("countAssemblyParts", () => {
  // ---- Case A: 2 tool-calls, 2 tool-results, 1 orphan ----
  test("returns correct counts for 2 tool-calls, 3 tool-results (2 paired + 1 orphan), 1 orphan message", () => {
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_1", "read"),
      makeAssistantToolCall("call_2", "write"),
      makeToolResult("call_1", "read", "result-1"),
      makeToolResult("call_2", "write", "result-2"),
      makeToolResult("call_orphan", "read", "no-pair"), // orphan tool message
    ]
    // Cross-check: orphanCount must equal what repairOrphanedToolResults drops.
    const repaired = repairOrphanedToolResults(input)
    const droppedByRepair = input.length - repaired.length
    expect(droppedByRepair).toBe(1)

    const counts = countAssemblyParts(input)
    expect(counts.toolCallCount).toBe(2)
    // toolResultCount counts ALL tool-result parts across all tool messages,
    // including orphans (BEFORE-repair semantics per task spec).
    expect(counts.toolResultCount).toBe(3)
    expect(counts.orphanCount).toBe(1)
    expect(counts.orphanCount).toBe(droppedByRepair)
  })

  // ---- Case B: empty fixture, all zeros ----
  test("returns all-zero counts for empty input", () => {
    const input: ModelMessage[] = []
    const counts = countAssemblyParts(input)
    expect(counts).toEqual({
      toolCallCount: 0,
      toolResultCount: 0,
      orphanCount: 0,
    })
  })

  // ---- Case C: 3 tool-calls across 2 assistant messages, 3 tool-results paired, 0 orphans ----
  test("returns correct counts for 3 tool-calls across 2 assistant messages, all paired", () => {
    const input: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_1", toolName: "read", input: {} },
          { type: "tool-call", toolCallId: "call_2", toolName: "write", input: {} },
        ],
      },
      makeToolResult("call_1", "read", "r1"),
      makeToolResult("call_2", "write", "r2"),
      makeAssistantToolCall("call_3", "bash"),
      makeToolResult("call_3", "bash", "r3"),
    ]
    const repaired = repairOrphanedToolResults(input)
    expect(repaired).toHaveLength(input.length) // no drops
    expect(input.length - repaired.length).toBe(0)

    const counts = countAssemblyParts(input)
    expect(counts.toolCallCount).toBe(3)
    expect(counts.toolResultCount).toBe(3)
    expect(counts.orphanCount).toBe(0)
  })

  // ---- Defensive shape coverage ----
  test("toolCallCount ignores non-array content (string assistants)", () => {
    const input: ModelMessage[] = [
      makeAssistantText("plain text"),
      makeAssistantToolCall("call_1"),
      makeToolResult("call_1"),
    ]
    const counts = countAssemblyParts(input)
    expect(counts.toolCallCount).toBe(1)
    expect(counts.toolResultCount).toBe(1)
    expect(counts.orphanCount).toBe(0)
  })

  test("toolResultCount only counts tool-role messages with array content", () => {
    // Intentionally malformed `user` message with a tool-result-shaped part
    // (typed via cast to bypass UserModelMessage content-shape narrowing). The
    // counter must still ignore it — only role === "tool" counts.
    const malformedUserAsToolResult = {
      role: "user",
      content: [
        {
          type: "tool-result",
          toolCallId: "bogus",
          toolName: "read",
          output: { type: "text", value: "x" },
        },
      ],
    } as unknown as ModelMessage
    const input: ModelMessage[] = [makeAssistantToolCall("call_1"), malformedUserAsToolResult, makeToolResult("call_1")]
    const counts = countAssemblyParts(input)
    expect(counts.toolResultCount).toBe(1)
    expect(counts.toolCallCount).toBe(1)
    expect(counts.orphanCount).toBe(0)
  })

  test("orphanCount equals the number of tool messages removed by repairOrphanedToolResults", () => {
    const input: ModelMessage[] = [
      makeAssistantToolCall("call_a"),
      makeToolResult("call_a"),
      makeToolResult("orphan_1"),
      makeAssistantToolCall("call_b"),
      makeToolResult("call_b"),
      makeToolResult("orphan_2"),
      makeToolResult("orphan_3"),
    ]
    const repaired = repairOrphanedToolResults(input)
    const dropped = input.length - repaired.length
    expect(dropped).toBe(3) // sanity check on the fixture itself

    const counts = countAssemblyParts(input)
    expect(counts.orphanCount).toBe(3)
    expect(counts.orphanCount).toBe(dropped)
    expect(counts.toolCallCount).toBe(2)
    expect(counts.toolResultCount).toBe(2 + 3) // all tool-result parts, including orphan ones
  })

  test("is pure — does not mutate input", () => {
    const input: ModelMessage[] = [makeAssistantToolCall("call_1"), makeToolResult("call_1"), makeToolResult("orphan")]
    const before = input.slice()
    const counts = countAssemblyParts(input)
    expect(input).toEqual(before)
    expect(counts).toEqual({ toolCallCount: 1, toolResultCount: 2, orphanCount: 1 })
  })
})

// ---------------------------------------------------------------------------
// Provider capability matrix — tool-result media routing
//
// Drives the converter (`toModelMessages`) with representative `model.api.npm`
// values and asserts which attachments land in tool-result content (the
// assistant message's `tool-*` part output) vs the synthetic user message
// (`SYNTHETIC_ATTACHMENT_PROMPT` + file parts). Behavior-level assertions
// only — no logger calls, no internal-map assertions.
// ---------------------------------------------------------------------------

function mediaAttachment(mime: string, url: string, filename: string): FilePart {
  return {
    id: PartID.make(`prt-${filename}`),
    sessionID: SessionID.make("ses-test"),
    messageID: MessageID.make("msg-tool-result"),
    type: "file",
    mime,
    filename,
    url,
  }
}

const MEDIA = {
  image: mediaAttachment("image/png", "data:image/png;base64,iVBORw0KGgo=", "attachment.png"),
  video: mediaAttachment("video/mp4", "data:video/mp4;base64,AAAAIGZ0eX", "attachment.mp4"),
  audio: mediaAttachment("audio/mpeg", "data:audio/mpeg;base64,SUQzBAAAA", "attachment.mp3"),
} as const

function makeModel(npm: string, id = "test-model"): Provider.Model {
  return {
    id: ModelID.make(id),
    providerID: ProviderID.make("test-provider"),
    api: { id, url: "http://test", npm },
    name: id,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2024-01-01",
  }
}

function makeAssistantToolWithAttachments(attachments: FilePart[]): WithParts {
  const msgID = MessageID.make("msg-tool-result")
  const partID = PartID.make("prt-tool-result")
  return {
    info: {
      id: msgID,
      role: "assistant",
      sessionID: SessionID.make("ses-test"),
      time: { created: Date.now(), completed: Date.now() },
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test-provider"),
      mode: "default",
      agent: "test",
      parentID: msgID,
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: partID,
        messageID: msgID,
        sessionID: SessionID.make("ses-test"),
        type: "tool",
        callID: "call_1",
        tool: "test-tool",
        state: {
          status: "completed",
          input: {},
          output: "ok",
          title: "test tool",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
          attachments,
        },
      },
    ],
  }
}

function toolResultOutputAttachments(messages: ModelMessage[]) {
  const media: Array<{ mediaType: string }> = []
  for (const msg of messages) {
    if (typeof msg.content === "string") continue
    for (const part of msg.content) {
      if (part.type !== "tool-result" || part.output.type !== "content") continue
      for (const p of part.output.value) {
        if (p.type === "media" || p.type === "file-data") media.push({ mediaType: p.mediaType })
      }
    }
  }
  return media
}

/** Narrow a synthetic user message's content to its file parts. */
function filePartsOf(message: ModelMessage | undefined): Array<{ mediaType: string }> {
  if (!message || typeof message.content === "string") return []
  return message.content.filter((p) => p.type === "file") as Array<{ mediaType: string }>
}

/** Narrow a synthetic user message's content to its text parts. */
function textPartsOf(message: ModelMessage | undefined): Array<{ text: string }> {
  if (!message || typeof message.content === "string") return []
  return message.content.filter((p) => p.type === "text") as Array<{ text: string }>
}

function syntheticUserMessage(messages: ModelMessage[]) {
  const found = messages.find(
    (m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "text" && p.text === SYNTHETIC_ATTACHMENT_PROMPT),
  )
  return found && Array.isArray(found.content) ? found : undefined
}

describe("provider capability map — tool-result media routing", () => {
  const allMedia = [MEDIA.image, MEDIA.video, MEDIA.audio]

  test("MCP-style full-media providers keep video/audio/image in tool-result content", async () => {
    for (const npm of ["@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/google-vertex/anthropic"]) {
      const messages = await toModelMessages([makeAssistantToolWithAttachments(allMedia)], makeModel(npm))
      const kept = toolResultOutputAttachments(messages)
      expect(kept.map((p) => p.mediaType)).toEqual(["image/png", "video/mp4", "audio/mpeg"])
      expect(syntheticUserMessage(messages)).toBeUndefined()
    }
  })

  test("bedrock keeps only image attachments in tool-result content; video/audio extracted", async () => {
    const npm = "@ai-sdk/amazon-bedrock"
    const messages = await toModelMessages([makeAssistantToolWithAttachments(allMedia)], makeModel(npm))
    const kept = toolResultOutputAttachments(messages)
    expect(kept.map((p) => p.mediaType)).toEqual(["image/png"])
    const synthetic = syntheticUserMessage(messages)
    expect(synthetic).toBeDefined()
    const files = filePartsOf(synthetic)
    expect(files.map((p) => p.mediaType)).toEqual(["video/mp4", "audio/mpeg"])
  })

  test("xai keeps only image attachments in tool-result content; video/audio extracted", async () => {
    const npm = "@ai-sdk/xai"
    const messages = await toModelMessages([makeAssistantToolWithAttachments(allMedia)], makeModel(npm))
    const kept = toolResultOutputAttachments(messages)
    expect(kept.map((p) => p.mediaType)).toEqual(["image/png"])
    const synthetic = syntheticUserMessage(messages)
    expect(synthetic).toBeDefined()
    const files = filePartsOf(synthetic)
    expect(files.map((p) => p.mediaType)).toEqual(["video/mp4", "audio/mpeg"])
  })

  test("google keeps media only for gemini-3 models; non-gemini-3 models extract", async () => {
    const gemini3 = await toModelMessages(
      [makeAssistantToolWithAttachments(allMedia)],
      makeModel("@ai-sdk/google", "gemini-3-pro"),
    )
    const keptGemini3 = toolResultOutputAttachments(gemini3)
    expect(keptGemini3.map((p) => p.mediaType)).toEqual(["image/png", "video/mp4", "audio/mpeg"])
    expect(syntheticUserMessage(gemini3)).toBeUndefined()

    const gemini25 = await toModelMessages(
      [makeAssistantToolWithAttachments(allMedia)],
      makeModel("@ai-sdk/google", "gemini-2.5-flash"),
    )
    const keptGemini25 = toolResultOutputAttachments(gemini25)
    expect(keptGemini25).toEqual([])
    const syntheticGemini25 = syntheticUserMessage(gemini25)
    expect(syntheticGemini25).toBeDefined()
    const files = filePartsOf(syntheticGemini25)
    expect(files.map((p) => p.mediaType)).toEqual(["image/png", "video/mp4", "audio/mpeg"])
  })

  test("moonshot (openai-compatible) keeps video+audio file parts in tool-result content", async () => {
    const npm = "@ai-sdk/openai-compatible"
    const messages = await toModelMessages([makeAssistantToolWithAttachments(allMedia)], makeModel(npm, "moonshot-v1"))
    const kept = toolResultOutputAttachments(messages)
    expect(kept.map((p) => p.mediaType)).toEqual(["video/mp4", "audio/mpeg"])
    // Image attachments are NOT claimed for openai-compatible — they stay in
    // the extracted synthetic user message (pre-existing default behavior).
    const synthetic = syntheticUserMessage(messages)
    expect(synthetic).toBeDefined()
    const files = filePartsOf(synthetic)
    expect(files.map((p) => p.mediaType)).toEqual(["image/png"])
  })

  test("default/unknown provider extracts all isMedia attachments to the synthetic user message", async () => {
    const npm = "unknown-provider"
    const messages = await toModelMessages([makeAssistantToolWithAttachments(allMedia)], makeModel(npm))
    const kept = toolResultOutputAttachments(messages)
    expect(kept).toEqual([])
    const synthetic = syntheticUserMessage(messages)
    expect(synthetic).toBeDefined()
    const files = filePartsOf(synthetic)
    expect(files.map((p) => p.mediaType)).toEqual(["image/png", "video/mp4", "audio/mpeg"])
    const textParts = textPartsOf(synthetic)
    expect(textParts.map((p) => p.text)).toEqual([SYNTHETIC_ATTACHMENT_PROMPT])
  })

  test("non-media attachments stay in tool-result content regardless of provider", async () => {
    const nonMedia = [mediaAttachment("text/plain", "file:///tmp/note.txt", "note.txt")]
    const messages = await toModelMessages(
      [makeAssistantToolWithAttachments([...allMedia, ...nonMedia])],
      makeModel("unknown-provider"),
    )
    const synthetic = syntheticUserMessage(messages)
    const syntheticFiles = filePartsOf(synthetic)
    expect(syntheticFiles.map((p) => p.mediaType)).toEqual(["image/png", "video/mp4", "audio/mpeg"])
    // text/plain is not isMedia → never extracted
    expect(syntheticFiles.map((p) => p.mediaType)).not.toContain("text/plain")
  })
})

// ---------------------------------------------------------------------------
// stripMedia — user file-part stripping and replay placeholder copy
//
// Compaction calls toModelMessagesEffect(..., { stripMedia: true }). User file
// parts that are media (image/video/audio/pdf — the `isMedia` set, ADR-1)
// become the generic replay placeholder `[Attached <mime>: <name>]`, and
// tool-result attachments are cleared entirely. Behavior assertions only —
// no logger-call assertions.
// ---------------------------------------------------------------------------

function makeUserWithFiles(text: string, files: FilePart[]): WithParts {
  const msgID = MessageID.make("msg-user-files")
  return {
    info: {
      id: msgID,
      role: "user",
      sessionID: SessionID.make("ses-test"),
      time: { created: Date.now() },
      agent: "test",
      model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
    },
    parts: [
      {
        id: PartID.make("prt-user-text"),
        messageID: msgID,
        sessionID: SessionID.make("ses-test"),
        type: "text",
        text,
      },
      ...files.map((file) => ({ ...file, messageID: msgID })),
    ],
  }
}

/** Text content of a user ModelMessage, whether content is a plain string or a part array. */
function textContentOf(message: ModelMessage | undefined): string {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  return message.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

describe("stripMedia — user file-part stripping & replay placeholder copy", () => {
  test("with stripMedia enabled, video/mp4 and audio/mpeg user file parts become generic placeholders", async () => {
    const messages = await toModelMessages(
      [makeUserWithFiles("here is the media", [MEDIA.image, MEDIA.video, MEDIA.audio])],
      makeModel("unknown-provider"),
      { stripMedia: true },
    )
    const userMsg = messages.find((m) => m.role === "user")
    const text = textContentOf(userMsg)
    expect(text).toContain("[Attached image/png: attachment.png]")
    expect(text).toContain("[Attached video/mp4: attachment.mp4]")
    expect(text).toContain("[Attached audio/mpeg: attachment.mp3]")
    // No media file part survives the strip
    expect(filePartsOf(userMsg)).toEqual([])
    // The pre-existing plain text is preserved
    expect(text).toContain("here is the media")
  })

  test("without stripMedia, video/audio user file parts remain real file parts", async () => {
    const messages = await toModelMessages(
      [makeUserWithFiles("here is the media", [MEDIA.video, MEDIA.audio])],
      makeModel("unknown-provider"),
    )
    const userMsg = messages.find((m) => m.role === "user")
    const files = filePartsOf(userMsg)
    expect(files.map((p) => p.mediaType)).toEqual(["video/mp4", "audio/mpeg"])
    const text = textContentOf(userMsg)
    expect(text).toContain("here is the media")
    expect(text).not.toContain("[Attached")
  })

  test("with stripMedia enabled, tool-result attachments are cleared for all media (no synthetic extraction)", async () => {
    const messages = await toModelMessages(
      [makeAssistantToolWithAttachments([MEDIA.image, MEDIA.video, MEDIA.audio])],
      makeModel("unknown-provider"),
      { stripMedia: true },
    )
    expect(toolResultOutputAttachments(messages)).toEqual([])
    expect(syntheticUserMessage(messages)).toBeUndefined()
  })

  test("SYNTHETIC_ATTACHMENT_PROMPT copy is unchanged", () => {
    expect(SYNTHETIC_ATTACHMENT_PROMPT).toBe("Attached media from tool result:")
  })
})

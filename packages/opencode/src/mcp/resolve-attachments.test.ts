import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { convertMcpTool, resolveAttachmentUris } from "./index"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

describe("resolveAttachmentUris — file path to base64", () => {
  let tempDir: string
  let tempFile: string
  let fileContent: Buffer

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"))
    fileContent = Buffer.from("hello world")
    tempFile = path.join(tempDir, "test.txt")
    fs.writeFileSync(tempFile, fileContent)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test("resolves absolute file path to base64", () => {
    const result = resolveAttachmentUris({ data: tempFile }) as { data: string }
    expect(result.data).toBe(fileContent.toString("base64"))
  })

  test("resolves file path passed as plain string", () => {
    const result = resolveAttachmentUris(tempFile) as string
    expect(result).toBe(fileContent.toString("base64"))
  })

  test("resolves nested file path in deep object", () => {
    const result = resolveAttachmentUris({
      nested: { deep: { data: tempFile } },
    }) as { nested: { deep: { data: string } } }
    expect(result.nested.deep.data).toBe(fileContent.toString("base64"))
  })

  test("resolves file path inside array", () => {
    const result = resolveAttachmentUris({ items: [tempFile, "other"] }) as { items: string[] }
    expect(result.items[0]).toBe(fileContent.toString("base64"))
    expect(result.items[1]).toBe("other")
  })

  test("resolves file path as top-level array element", () => {
    const result = resolveAttachmentUris([tempFile, "other"]) as string[]
    expect(result[0]).toBe(fileContent.toString("base64"))
    expect(result[1]).toBe("other")
  })

  test("throws for file exceeding 10MB limit", () => {
    const largeFile = path.join(tempDir, "large.bin")
    fs.writeFileSync(largeFile, Buffer.alloc(10 * 1024 * 1024 + 1))
    expect(() => resolveAttachmentUris({ data: largeFile })).toThrow("File too large")
  })

  test("allows file at exactly 10MB", () => {
    const exactFile = path.join(tempDir, "exact.bin")
    fs.writeFileSync(exactFile, Buffer.alloc(10 * 1024 * 1024))
    const result = resolveAttachmentUris({ data: exactFile }) as { data: string }
    expect(typeof result.data).toBe("string")
    expect(result.data.length).toBeGreaterThan(0)
  })

  test("passes through existing absolute directory path unchanged", () => {
    const result = resolveAttachmentUris({ data: tempDir }) as { data: string }
    expect(result.data).toBe(tempDir)
  })

  test("passes through existing absolute directory path in nested queries unchanged", () => {
    const result = resolveAttachmentUris({
      queries: [
        {
          pattern: "resolveAttachmentUris",
          path: tempDir,
        },
      ],
    }) as { queries: Array<{ pattern: string; path: string }> }

    expect(result.queries[0].path).toBe(tempDir)
  })

  test("forwards an existing absolute directory path unchanged through converted MCP tool execution", async () => {
    let callToolRequest: unknown
    const callTool = mock(async (request: unknown) => {
      callToolRequest = request
      return { content: [{ type: "text", text: "ok" }] }
    })
    const tool = convertMcpTool(
      {
        name: "localSearchCode",
        inputSchema: {
          type: "object",
          properties: {
            queries: { type: "array" },
          },
        },
      },
      { callTool } as unknown as Parameters<typeof convertMcpTool>[1],
    )
    const args = {
      queries: [
        {
          pattern: "resolveAttachmentUris",
          path: tempDir,
        },
      ],
    }

    const executableTool = tool as unknown as { execute: (args: unknown) => Promise<unknown> }

    await expect(executableTool.execute(args)).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    })

    expect(callTool).toHaveBeenCalledTimes(1)
    expect(callToolRequest).toMatchObject({
      name: "localSearchCode",
      arguments: {
        queries: [
          {
            pattern: "resolveAttachmentUris",
            path: tempDir,
          },
        ],
      },
    })
    expect(JSON.stringify(callToolRequest)).not.toContain("Not a regular file")
  })

  test("passes through non-existent file paths unchanged (write destinations)", () => {
    // Non-existent absolute paths may be write destinations (e.g., screenshot filePath)
    const result = resolveAttachmentUris({ data: "/nonexistent/file.png" }) as { data: string }
    expect(result.data).toBe("/nonexistent/file.png")
  })

  test("passes through relative paths unchanged", () => {
    const result = resolveAttachmentUris({ data: "relative/path.png" }) as { data: string }
    expect(result.data).toBe("relative/path.png")
  })

  test("passes through dot-relative paths unchanged", () => {
    const result = resolveAttachmentUris({ data: "./screenshot.png" }) as { data: string }
    expect(result.data).toBe("./screenshot.png")
  })

  test("passes through numbers unchanged", () => {
    expect(resolveAttachmentUris(42)).toBe(42)
    expect(resolveAttachmentUris({ count: 42 })).toEqual({ count: 42 })
  })

  test("passes through booleans unchanged", () => {
    expect(resolveAttachmentUris(true)).toBe(true)
    expect(resolveAttachmentUris(false)).toBe(false)
  })

  test("passes through null unchanged", () => {
    expect(resolveAttachmentUris(null)).toBe(null)
  })

  test("passes through undefined unchanged", () => {
    expect(resolveAttachmentUris(undefined)).toBe(undefined)
  })

  test("passes through opencode://attachment URIs unchanged (no temp file to resolve)", () => {
    const result = resolveAttachmentUris({ data: "opencode://attachment/abc123.png" }) as { data: string }
    // The function will try to resolve the attachment; since no temp file exists,
    // it returns the original URI (existing behavior)
    expect(result.data).toBe("opencode://attachment/abc123.png")
  })

  test("handles mixed content: file path + opencode URI + plain string", () => {
    const result = resolveAttachmentUris({
      file: tempFile,
      uri: "opencode://attachment/abc123.png",
      plain: "just a string",
    }) as { file: string; uri: string; plain: string }
    expect(result.file).toBe(fileContent.toString("base64"))
    expect(result.uri).toBe("opencode://attachment/abc123.png")
    expect(result.plain).toBe("just a string")
  })

  test("handles binary file content correctly", () => {
    const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) // PNG header
    const binaryFile = path.join(tempDir, "image.png")
    fs.writeFileSync(binaryFile, binaryContent)
    const result = resolveAttachmentUris({ data: binaryFile }) as { data: string }
    expect(result.data).toBe(binaryContent.toString("base64"))
  })

  test("handles deeply nested arrays and objects", () => {
    const result = resolveAttachmentUris({
      level1: {
        level2: [
          { path: tempFile },
          { path: "not-a-file" },
        ],
      },
    }) as { level1: { level2: Array<{ path: string }> } }
    expect(result.level1.level2[0].path).toBe(fileContent.toString("base64"))
    expect(result.level1.level2[1].path).toBe("not-a-file")
  })

  test("passes through non-existent file path with path preserved in pass-through", () => {
    const missingPath = "/tmp/does-not-exist-12345.txt"
    expect(resolveAttachmentUris(missingPath)).toBe(missingPath)
  })

  test("throws with path in error message for file too large", () => {
    const largeFile = path.join(tempDir, "huge.bin")
    fs.writeFileSync(largeFile, Buffer.alloc(11 * 1024 * 1024))
    expect(() => resolveAttachmentUris(largeFile)).toThrow(largeFile)
  })
})

describe("resolveAttachmentUris — inclusion-based file path resolution", () => {
  let tempDir: string
  let tempFile: string
  let fileContent: Buffer

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"))
    fileContent = Buffer.from("hello world")
    tempFile = path.join(tempDir, "test.txt")
    fs.writeFileSync(tempFile, fileContent)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test("no options: legacy behavior — file path resolved to base64", () => {
    const result = resolveAttachmentUris({ data: tempFile }) as { data: string }
    expect(result.data).toBe(fileContent.toString("base64"))
  })

  test("featureEnabled false: file path passes through unchanged", () => {
    const result = resolveAttachmentUris({ data: tempFile }, {
      featureEnabled: false,
    }) as { data: string }
    expect(result.data).toBe(tempFile)
  })

  test("includeMCP populated, server NOT in list: file path passes through", () => {
    const result = resolveAttachmentUris({ data: tempFile }, {
      currentMcpServer: "octocode",
      includeMCP: ["hugging-kreuzberg"],
      featureEnabled: true,
    }) as { data: string }
    expect(result.data).toBe(tempFile)
  })

  test("includeMCP populated, server IN list: file path resolved to base64", () => {
    const result = resolveAttachmentUris({ data: tempFile }, {
      currentMcpServer: "hugging-kreuzberg",
      includeMCP: ["hugging-kreuzberg"],
      featureEnabled: true,
    }) as { data: string }
    expect(result.data).toBe(fileContent.toString("base64"))
  })

  test("includeMCP empty: legacy fallback — file path resolved to base64", () => {
    const result = resolveAttachmentUris({ data: tempFile }, {
      currentMcpServer: "octocode",
      includeMCP: [],
      featureEnabled: true,
    }) as { data: string }
    expect(result.data).toBe(fileContent.toString("base64"))
  })

  test("includeMCP unset (undefined): legacy fallback — file path resolved to base64", () => {
    const result = resolveAttachmentUris({ data: tempFile }, {
      currentMcpServer: "octocode",
      featureEnabled: true,
    }) as { data: string }
    expect(result.data).toBe(fileContent.toString("base64"))
  })

  test("featureEnabled false: attachment URI still resolves", () => {
    // Attachment URIs always resolve regardless of featureEnabled
    const result = resolveAttachmentUris({
      data: "opencode://attachment/abc123.png",
    }, {
      featureEnabled: false,
    }) as { data: string }
    // No temp file exists, so it falls back to original URI
    expect(result.data).toBe("opencode://attachment/abc123.png")
  })

  test("excluded server: attachment URI resolves, file path passes through (mixed)", () => {
    const result = resolveAttachmentUris({
      file: tempFile,
      uri: "opencode://attachment/abc123.png",
    }, {
      currentMcpServer: "octocode",
      includeMCP: ["hugging-kreuzberg"],
      featureEnabled: true,
    }) as { file: string; uri: string }
    expect(result.file).toBe(tempFile) // excluded — passes through
    expect(result.uri).toBe("opencode://attachment/abc123.png") // attachment URI still processed (no temp file, so original)
  })

  test("options forwarded through nested arrays", () => {
    const result = resolveAttachmentUris({
      items: [tempFile, "other"],
    }, {
      currentMcpServer: "octocode",
      includeMCP: ["hugging-kreuzberg"],
      featureEnabled: true,
    }) as { items: string[] }
    expect(result.items[0]).toBe(tempFile) // excluded — passes through
    expect(result.items[1]).toBe("other")
  })

  test("options forwarded through nested objects", () => {
    const result = resolveAttachmentUris({
      nested: { deep: { data: tempFile } },
    }, {
      currentMcpServer: "octocode",
      includeMCP: ["hugging-kreuzberg"],
      featureEnabled: true,
    }) as { nested: { deep: { data: string } } }
    expect(result.nested.deep.data).toBe(tempFile) // excluded — passes through
  })

  test("options forwarded through top-level array", () => {
    const result = resolveAttachmentUris([tempFile, "other"], {
      currentMcpServer: "octocode",
      includeMCP: ["hugging-kreuzberg"],
      featureEnabled: true,
    }) as string[]
    expect(result[0]).toBe(tempFile) // excluded — passes through
    expect(result[1]).toBe("other")
  })

  test("featureEnabled false: non-existent path still passes through", () => {
    const result = resolveAttachmentUris({ data: "/nonexistent/file.png" }, {
      featureEnabled: false,
    }) as { data: string }
    expect(result.data).toBe("/nonexistent/file.png")
  })

  test("featureEnabled false: directory still passes through", () => {
    const result = resolveAttachmentUris({ data: tempDir }, {
      featureEnabled: false,
    }) as { data: string }
    expect(result.data).toBe(tempDir)
  })

  test("convertMcpTool: excluded server passes file path through unchanged", async () => {
    let callToolRequest: unknown
    const callTool = mock(async (request: unknown) => {
      callToolRequest = request
      return { content: [{ type: "text", text: "ok" }] }
    })
    const tool = convertMcpTool(
      {
        name: "getContents",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
      },
      { callTool } as unknown as Parameters<typeof convertMcpTool>[1],
      undefined,
      {
        mcpServerName: "octocode",
        features: {
          mcpFilePathBase64Encode: {
            enable: true,
            includeMCP: ["hugging-kreuzberg"],
          },
        },
      },
    )
    const args = { path: tempFile }
    const executableTool = tool as unknown as { execute: (args: unknown) => Promise<unknown> }

    await expect(executableTool.execute(args)).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    })

    // Path should pass through unchanged (not base64-encoded) since octocode is NOT in includeMCP
    expect(callToolRequest).toMatchObject({
      name: "getContents",
      arguments: { path: tempFile },
    })
  })

  test("convertMcpTool: included server resolves file path to base64", async () => {
    let callToolRequest: unknown
    const callTool = mock(async (request: unknown) => {
      callToolRequest = request
      return { content: [{ type: "text", text: "ok" }] }
    })
    const tool = convertMcpTool(
      {
        name: "processImage",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
      },
      { callTool } as unknown as Parameters<typeof convertMcpTool>[1],
      undefined,
      {
        mcpServerName: "hugging-kreuzberg",
        features: {
          mcpFilePathBase64Encode: {
            enable: true,
            includeMCP: ["hugging-kreuzberg"],
          },
        },
      },
    )
    const args = { path: tempFile }
    const executableTool = tool as unknown as { execute: (args: unknown) => Promise<unknown> }

    await expect(executableTool.execute(args)).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    })

    // Path should be resolved to base64 since hugging-kreuzberg IS in includeMCP
    expect(callToolRequest).toMatchObject({
      name: "processImage",
      arguments: { path: fileContent.toString("base64") },
    })
  })

  test("convertMcpTool: enable false passes file path through unchanged", async () => {
    let callToolRequest: unknown
    const callTool = mock(async (request: unknown) => {
      callToolRequest = request
      return { content: [{ type: "text", text: "ok" }] }
    })
    const tool = convertMcpTool(
      {
        name: "getContents",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
      },
      { callTool } as unknown as Parameters<typeof convertMcpTool>[1],
      undefined,
      {
        mcpServerName: "hugging-kreuzberg",
        features: {
          mcpFilePathBase64Encode: {
            enable: false,
            includeMCP: ["hugging-kreuzberg"],
          },
        },
      },
    )
    const args = { path: tempFile }
    const executableTool = tool as unknown as { execute: (args: unknown) => Promise<unknown> }

    await expect(executableTool.execute(args)).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    })

    // Path should pass through unchanged since enable is false
    expect(callToolRequest).toMatchObject({
      name: "getContents",
      arguments: { path: tempFile },
    })
  })
})

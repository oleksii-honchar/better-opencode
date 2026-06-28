import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { resolveAttachmentUris } from "./index"
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
    const result = resolveAttachmentUris({ data: tempFile })
    expect(result.data).toBe(fileContent.toString("base64"))
  })

  test("resolves file path passed as plain string", () => {
    const result = resolveAttachmentUris(tempFile)
    expect(result).toBe(fileContent.toString("base64"))
  })

  test("resolves nested file path in deep object", () => {
    const result = resolveAttachmentUris({
      nested: { deep: { data: tempFile } },
    })
    expect(result.nested.deep.data).toBe(fileContent.toString("base64"))
  })

  test("resolves file path inside array", () => {
    const result = resolveAttachmentUris({ items: [tempFile, "other"] })
    expect(result.items[0]).toBe(fileContent.toString("base64"))
    expect(result.items[1]).toBe("other")
  })

  test("resolves file path as top-level array element", () => {
    const result = resolveAttachmentUris([tempFile, "other"])
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
    const result = resolveAttachmentUris({ data: exactFile })
    expect(typeof result.data).toBe("string")
    expect(result.data.length).toBeGreaterThan(0)
  })

  test("throws for directory path", () => {
    expect(() => resolveAttachmentUris({ data: tempDir })).toThrow("Not a regular file")
  })

  test("passes through non-existent file paths unchanged (write destinations)", () => {
    // Non-existent absolute paths may be write destinations (e.g., screenshot filePath)
    const result = resolveAttachmentUris({ data: "/nonexistent/file.png" })
    expect(result.data).toBe("/nonexistent/file.png")
  })

  test("passes through relative paths unchanged", () => {
    const result = resolveAttachmentUris({ data: "relative/path.png" })
    expect(result.data).toBe("relative/path.png")
  })

  test("passes through dot-relative paths unchanged", () => {
    const result = resolveAttachmentUris({ data: "./screenshot.png" })
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
    const result = resolveAttachmentUris({ data: "opencode://attachment/abc123.png" })
    // The function will try to resolve the attachment; since no temp file exists,
    // it returns the original URI (existing behavior)
    expect(result.data).toBe("opencode://attachment/abc123.png")
  })

  test("handles mixed content: file path + opencode URI + plain string", () => {
    const result = resolveAttachmentUris({
      file: tempFile,
      uri: "opencode://attachment/abc123.png",
      plain: "just a string",
    })
    expect(result.file).toBe(fileContent.toString("base64"))
    expect(result.uri).toBe("opencode://attachment/abc123.png")
    expect(result.plain).toBe("just a string")
  })

  test("handles binary file content correctly", () => {
    const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) // PNG header
    const binaryFile = path.join(tempDir, "image.png")
    fs.writeFileSync(binaryFile, binaryContent)
    const result = resolveAttachmentUris({ data: binaryFile })
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
    })
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

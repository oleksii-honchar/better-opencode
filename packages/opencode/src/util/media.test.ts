import { describe, test, expect } from "bun:test"
import { isMedia } from "@/util/media"

describe("isMedia", () => {
  test("video MIME types are media", () => {
    expect(isMedia("video/mp4")).toBe(true)
    expect(isMedia("video/webm")).toBe(true)
    expect(isMedia("video/quicktime")).toBe(true)
  })

  test("audio MIME types are media", () => {
    expect(isMedia("audio/mpeg")).toBe(true)
    expect(isMedia("audio/wav")).toBe(true)
    expect(isMedia("audio/aac")).toBe(true)
  })

  test("image MIME types remain media (regression)", () => {
    expect(isMedia("image/png")).toBe(true)
    expect(isMedia("image/gif")).toBe(true)
    expect(isMedia("image/jpeg")).toBe(true)
  })

  test("application/pdf remains media (regression)", () => {
    expect(isMedia("application/pdf")).toBe(true)
  })

  test("non-media MIME types are not media", () => {
    expect(isMedia("text/plain")).toBe(false)
    expect(isMedia("application/json")).toBe(false)
    expect(isMedia("text/html")).toBe(false)
  })

  test("boundary: subtype-less media MIME counts as media (startsWith semantics)", () => {
    // Agreed boundary: isMedia uses startsWith, so a bare top-level type with a
    // trailing slash ("video/", "audio/") is media even without a subtype.
    expect(isMedia("video/")).toBe(true)
    expect(isMedia("audio/")).toBe(true)
  })

  test("boundary: bare type without slash is not media (startsWith semantics)", () => {
    // startsWith("video/") requires the slash — a bare "video" is not media.
    expect(isMedia("video")).toBe(false)
    expect(isMedia("audio")).toBe(false)
  })
})
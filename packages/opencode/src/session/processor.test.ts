import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Image } from "@/image/image"
import {
  normalizeToolResultAttachments,
  shouldNormalizeToolAttachment,
  toolResultOmissionSuffix,
} from "@/session/processor"

type Attachment = { mime: string; url: string }

// ---------------------------------------------------------------------------
// Task 3 — Widen tool-result normalization gate for media passthrough.
// The normalization decision must stay explicitly media-aware: images keep
// resize, `video/*`/`audio/*` pass through un-normalized (temp files — no
// resize, no omission message), non-media passthrough unchanged, and the
// omission counter/message applies only to failed image resizes.
// --------------------------------------------------------------------------

function filePart(mime: string, url = `opencode://attachment/${mime.replace("/", "-")}`): Attachment {
  return { mime, url }
}

describe("shouldNormalizeToolAttachment", () => {
  test("images route to image normalization (resize path preserved)", () => {
    expect(shouldNormalizeToolAttachment(filePart("image/png"))).toBe(true)
    expect(shouldNormalizeToolAttachment(filePart("image/jpeg"))).toBe(true)
    expect(shouldNormalizeToolAttachment(filePart("image/gif"))).toBe(true)
  })

  test("video and audio attachments pass through without normalization", () => {
    expect(shouldNormalizeToolAttachment(filePart("video/mp4"))).toBe(false)
    expect(shouldNormalizeToolAttachment(filePart("audio/mpeg"))).toBe(false)
  })

  test("non-media attachments pass through unchanged", () => {
    expect(shouldNormalizeToolAttachment(filePart("text/plain"))).toBe(false)
    expect(shouldNormalizeToolAttachment(filePart("application/pdf"))).toBe(false)
  })
})

function successValue(exit: Exit.Exit<Attachment, Image.Error>): Attachment {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

describe("normalizeToolResultAttachments", () => {
  test("video/audio pass through with MIME and URL unchanged (no resize attempt)", () => {
    const video = filePart("video/mp4", "opencode://attachment/video.mp4")
    const audio = filePart("audio/mpeg", "opencode://attachment/audio.mp3")
    const text = filePart("text/plain", "opencode://attachment/notes.txt")
    const calls: Attachment[] = []
    const normalize = (attachment: Attachment) => {
      calls.push(attachment)
      return Effect.succeed({ ...attachment, url: "mutated" })
    }

    const result = Effect.runSync(normalizeToolResultAttachments([video, audio, text], normalize))

    expect(calls).toEqual([])
    expect(result).toHaveLength(3)
    expect(Exit.isSuccess(result[0])).toBe(true)
    expect(Exit.isSuccess(result[1])).toBe(true)
    expect(Exit.isSuccess(result[2])).toBe(true)
    expect(successValue(result[0])).toEqual(video)
    expect(successValue(result[1])).toEqual(audio)
    expect(successValue(result[2])).toEqual(text)
  })

  test("image attachments still route to image normalization (resize path)", () => {
    const image = filePart("image/png", "data:image/png;base64,AAAA")
    const calls: Attachment[] = []
    const normalize = (attachment: Attachment) => {
      calls.push(attachment)
      return Effect.succeed({ ...attachment, url: "data:image/png;base64,resized" })
    }

    const result = Effect.runSync(normalizeToolResultAttachments([image], normalize))

    expect(calls).toEqual([image])
    expect(Exit.isSuccess(result[0])).toBe(true)
    expect(successValue(result[0])).toMatchObject({
      mime: "image/png",
      url: "data:image/png;base64,resized",
    })
  })

  test("omission counter counts only failed image resizes; video/audio never count", () => {
    const video = filePart("video/mp4", "opencode://attachment/video.mp4")
    const audio = filePart("audio/mpeg", "opencode://attachment/audio.mp3")
    const imageOk = filePart("image/png", "data:image/png;base64,AAAA")
    const imageFail = filePart("image/jpeg", "data:image/jpeg;base64,BBBB")
    const normalize = (attachment: Attachment) =>
      attachment.mime === "image/jpeg"
        ? Effect.fail(
            new Image.SizeError({
              bytes: 1,
              max: 1,
              width: 1,
              height: 1,
              max_width: 1,
              max_height: 1,
            }),
          )
        : Effect.succeed({ ...attachment, url: "resized" })

    const result = Effect.runSync(normalizeToolResultAttachments([video, audio, imageOk, imageFail], normalize))
    const omitted = result.filter(Exit.isFailure).length
    const attachments = result.filter(Exit.isSuccess).map((item) => item.value)

    expect(omitted).toBe(1)
    expect(attachments).toHaveLength(3)
    expect(attachments[0]).toEqual(video)
    expect(attachments[1]).toEqual(audio)
    expect(attachments[2]).toMatchObject({ mime: "image/png", url: "resized" })
  })

  test("ResizerUnavailableError falls back to the original attachment (passthrough)", () => {
    const image = filePart("image/png", "data:image/png;base64,AAAA")
    const normalize = () => Effect.fail(new Image.ResizerUnavailableError())

    const result = Effect.runSync(normalizeToolResultAttachments([image], normalize))

    expect(Exit.isSuccess(result[0])).toBe(true)
    expect(successValue(result[0])).toEqual(image)
  })
})

describe("toolResultOmissionSuffix", () => {
  test("returns undefined when nothing was omitted", () => {
    expect(toolResultOmissionSuffix(0)).toBeUndefined()
  })

  test("preserves the exact existing singular/plural image omission copy", () => {
    expect(toolResultOmissionSuffix(1)).toBe(
      "\n\n[1 image omitted: could not be resized below the image size limit.]",
    )
    expect(toolResultOmissionSuffix(2)).toBe(
      "\n\n[2 images omitted: could not be resized below the image size limit.]",
    )
  })

  test("omission message appends to tool output only when images were omitted", () => {
    const output = "tool produced this"
    const omitted = 1
    const suffix = toolResultOmissionSuffix(omitted)
    const result = suffix === undefined ? output : `${output}${suffix}`

    expect(result).toBe("tool produced this\n\n[1 image omitted: could not be resized below the image size limit.]")
  })
})

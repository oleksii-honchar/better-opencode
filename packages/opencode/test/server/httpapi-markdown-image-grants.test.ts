import { afterEach, describe, expect } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { MarkdownImageGrantsPaths } from "../../src/server/routes/instance/httpapi/groups/markdown-image-grants"
import {
  MARKDOWN_MEDIA_MAX_BYTES,
  SUPPORTED_MEDIA_MIME_TYPES,
  KIND_BY_EXTENSION,
  MARKDOWN_IMAGE_GRANT_TTL_MS,
  MAX_IMAGE_GRANT_PATHS_PER_MESSAGE,
} from "../../src/server/routes/instance/httpapi/groups/markdown-image-grants"
import { Session } from "../../src/session/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { isLocalWorkspaceRoute } from "../../src/server/shared/workspace-routing"
import { Database } from "@/storage/db"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)

const it = testEffect(Layer.mergeAll(instanceStoreLayer, Project.defaultLayer, Session.defaultLayer))

function app() {
  return Server.Default().app
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => app().request(path, init))
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json())
}

function createAssistantMessage(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      parentID: MessageID.ascending(),
      agent: "build",
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
      mode: "build",
      path: { cwd: "/test", root: "/test" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    })
    yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return info
  })
}

function createSession() {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    return yield* svc.create({ title: "markdown image grants test" })
  })
}

async function createPNGFile(dir: string, name: string): Promise<string> {
  // Minimal valid PNG: 8-byte signature + IHDR + IDAT + IEND chunks
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, // IDAT
    0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x82, 0x24, 0x7c, 0xc1,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82, // IEND
  ])
  const filePath = path.join(dir, name)
  await fs.writeFile(filePath, png)
  return filePath
}

async function createJPEGFile(dir: string, name: string): Promise<string> {
  // Minimal valid JPEG: SOI + APP0 (JFIF) + EOI
  const jpeg = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
    0xff, 0xd9, // EOI
  ])
  const filePath = path.join(dir, name)
  await fs.writeFile(filePath, jpeg)
  return filePath
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("markdown-image-grants HttpApi", () => {
    it.instance(
    "returns 200 with ready status for valid image inside workspace",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const session = yield* createSession()
        const workspaceImage = path.join(instance.directory, "workspace-image.png")
        yield* Effect.promise(() => createPNGFile(instance.directory, "workspace-image.png"))

        const assistantMessage = yield* createAssistantMessage(
          session.id,
          `![alt](${workspaceImage})`,
        )

        const response = yield* request(
          pathFor(MarkdownImageGrantsPaths.grants, { sessionID: session.id }),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": instance.directory,
            },
            body: JSON.stringify({
              directory: instance.directory,
              messageId: assistantMessage.id,
              sources: [workspaceImage],
            }),
          },
        )

        expect(response.status).toBe(200)
        const body = yield* responseJson(response)
        expect(body.results).toHaveLength(1)
        expect(body.results[0]?.source).toBe(workspaceImage)
        expect(body.results[0]?.status).toBe("ready")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

    it.instance(
    "returns 200 with ready status and grant for image outside workspace (no env flag)",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const session = yield* createSession()

        // Create an outside workspace directory
        const outsideDir = path.join(os.tmpdir(), `opencode-outside-${Date.now()}`)
        yield* Effect.promise(() => fs.mkdir(outsideDir, { recursive: true }))
        const outsideImage = yield* Effect.promise(() => createPNGFile(outsideDir, "outside-image.png"))

        const assistantMessage = yield* createAssistantMessage(
          session.id,
          `![alt](${outsideImage})`,
        )

        const response = yield* request(
          pathFor(MarkdownImageGrantsPaths.grants, { sessionID: session.id }),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": instance.directory,
            },
            body: JSON.stringify({
              directory: instance.directory,
              messageId: assistantMessage.id,
              sources: [outsideImage],
            }),
          },
        )

        expect(response.status).toBe(200)
        const body = yield* responseJson(response)
        expect(body.results).toHaveLength(1)
        expect(body.results[0]?.status).toBe("ready")
        expect(body.results[0]?.outsideFileGrant).toBeDefined()
        expect(body.results[0]?.outsideFileGrant).not.toBeNull()
        expect(body.results[0]?.expiresAt).toBeDefined()
        expect(body.results[0]?.expiresAt).toBeGreaterThan(Date.now())

        // Cleanup
        yield* Effect.promise(() => fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {}))
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

    it.instance(
    "returns missing status for non-existent file",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const session = yield* createSession()
        const missingPath = path.join(instance.directory, "does-not-exist.png")

        const assistantMessage = yield* createAssistantMessage(
          session.id,
          `![alt](${missingPath})`,
        )

        const response = yield* request(
          pathFor(MarkdownImageGrantsPaths.grants, { sessionID: session.id }),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": instance.directory,
            },
            body: JSON.stringify({
              directory: instance.directory,
              messageId: assistantMessage.id,
              sources: [missingPath],
            }),
          },
        )

        expect(response.status).toBe(200)
        const body = yield* responseJson(response)
        expect(body.results).toHaveLength(1)
        expect(body.results[0]?.status).toBe("missing")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

    it.instance(
    "returns 404 for non-existent message",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const session = yield* createSession()
        const nonExistentMessage = MessageID.ascending()

        const response = yield* request(
          pathFor(MarkdownImageGrantsPaths.grants, { sessionID: session.id }),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": instance.directory,
            },
            body: JSON.stringify({
              directory: instance.directory,
              messageId: nonExistentMessage,
              sources: [path.join(instance.directory, "test.png")],
            }),
          },
        )

        expect(response.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

    it.instance(
    "returns 404 for user role message (not assistant)",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const session = yield* createSession()

        // Create a user message instead of assistant
        const userMessage = Effect.gen(function* () {
          const svc = yield* Session.Service
          const info = yield* svc.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
            time: { created: Date.now() },
          })
          yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: info.id,
            type: "text",
            text: `![alt](${path.join(instance.directory, "test.png")})`,
          })
          return info
        })
        const message = yield* userMessage

        const response = yield* request(
          pathFor(MarkdownImageGrantsPaths.grants, { sessionID: session.id }),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": instance.directory,
            },
            body: JSON.stringify({
              directory: instance.directory,
              messageId: message.id,
              sources: [path.join(instance.directory, "test.png")],
            }),
          },
        )

        expect(response.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.effect("exports correct media max bytes for image", () =>
    Effect.sync(() => {
      const MIB = 1024 * 1024
      expect(MARKDOWN_MEDIA_MAX_BYTES.image).toBe(10 * MIB)
      expect(MARKDOWN_MEDIA_MAX_BYTES.video).toBe(50 * MIB)
      expect(MARKDOWN_MEDIA_MAX_BYTES.audio).toBe(20 * MIB)
    }),
  )

  it.effect("exports correct supported media MIME types", () =>
    Effect.sync(() => {
      expect(SUPPORTED_MEDIA_MIME_TYPES.has("image/png")).toBe(true)
      expect(SUPPORTED_MEDIA_MIME_TYPES.has("image/jpeg")).toBe(true)
      expect(SUPPORTED_MEDIA_MIME_TYPES.has("image/gif")).toBe(true)
      expect(SUPPORTED_MEDIA_MIME_TYPES.has("image/webp")).toBe(true)
      expect(SUPPORTED_MEDIA_MIME_TYPES.has("video/mp4")).toBe(true)
      expect(SUPPORTED_MEDIA_MIME_TYPES.has("video/webm")).toBe(true)
      expect(SUPPORTED_MEDIA_MIME_TYPES.has("audio/mpeg")).toBe(true)
      expect(SUPPORTED_MEDIA_MIME_TYPES.has("audio/wav")).toBe(true)
      expect(SUPPORTED_MEDIA_MIME_TYPES.has("audio/mp4")).toBe(true)
    }),
  )

  it.effect("exports correct kind by extension map", () =>
    Effect.sync(() => {
      expect(KIND_BY_EXTENSION.png).toBe("image")
      expect(KIND_BY_EXTENSION.jpg).toBe("image")
      expect(KIND_BY_EXTENSION.jpeg).toBe("image")
      expect(KIND_BY_EXTENSION.gif).toBe("image")
      expect(KIND_BY_EXTENSION.webp).toBe("image")
      expect(KIND_BY_EXTENSION.mp4).toBe("video")
      expect(KIND_BY_EXTENSION.webm).toBe("video")
      expect(KIND_BY_EXTENSION.mp3).toBe("audio")
      expect(KIND_BY_EXTENSION.wav).toBe("audio")
      expect(KIND_BY_EXTENSION.m4a).toBe("audio")
    }),
  )

  it.effect("exports correct grant TTL (10 minutes)", () =>
    Effect.sync(() => {
      expect(MARKDOWN_IMAGE_GRANT_TTL_MS).toBe(600000)
    }),
  )

  it.effect("exports correct max sources per message", () =>
    Effect.sync(() => {
      expect(MAX_IMAGE_GRANT_PATHS_PER_MESSAGE).toBe(12)
    }),
  )

  it.effect("isLocalWorkspaceRoute returns true for grants path", () =>
    Effect.sync(() => {
      expect(isLocalWorkspaceRoute("POST", "/api/openchamber/sessions")).toBe(true)
      expect(isLocalWorkspaceRoute("POST", "/api/openchamber/sessions/sess_123")).toBe(true)
      expect(
        isLocalWorkspaceRoute("POST", "/api/openchamber/sessions/sess_123/markdown-image-grants"),
      ).toBe(true)
    }),
  )

  it.effect("isLocalWorkspaceRoute returns false for unrelated paths", () =>
    Effect.sync(() => {
      expect(isLocalWorkspaceRoute("POST", "/config")).toBe(false)
      expect(isLocalWorkspaceRoute("GET", "/files")).toBe(false)
    }),
  )
})

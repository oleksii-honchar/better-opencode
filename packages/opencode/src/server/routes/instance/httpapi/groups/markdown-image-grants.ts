import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { MessageNotFoundError } from "../errors"

// Parity constants - duplicated from better-openchamber/packages/web/server/lib/markdown-image-grants/routes.js
// These MUST match the web server values exactly (parity-tested)

const MIB = 1024 * 1024

export const MARKDOWN_MEDIA_MAX_BYTES = {
  image: 10 * MIB,
  video: 50 * MIB,
  audio: 20 * MIB,
} as const

export const SUPPORTED_MEDIA_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
])

export const KIND_BY_EXTENSION: Record<string, "image" | "video" | "audio"> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  mp4: "video",
  webm: "video",
  m4v: "video",
  mov: "video",
  ogv: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
}

export const MARKDOWN_IMAGE_GRANT_TTL_MS = 10 * 60 * 1000

export const MAX_IMAGE_GRANT_PATHS_PER_MESSAGE = 12

export const MarkdownImageGrantsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
})

export const MarkdownImageGrantStatus = Schema.Union([
  Schema.Literal("ready"),
  Schema.Literal("missing"),
  Schema.Literal("error"),
])

export const MarkdownImageGrantSource = Schema.Struct({
  source: Schema.String,
  status: MarkdownImageGrantStatus,
  path: Schema.optional(Schema.String),
  outsideFileGrant: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
})

export const MarkdownImageGrantsPayload = Schema.Struct({
  directory: Schema.String,
  messageId: Schema.String,
  sources: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
})

export const MarkdownImageGrantsResponse = Schema.Struct({
  results: Schema.Array(MarkdownImageGrantSource),
})

export const MarkdownImageGrantsPaths = {
  grants: "/api/openchamber/sessions/:sessionID/markdown-image-grants",
} as const

export const MarkdownImageGrantsApi = HttpApi.make("markdown-image-grants")
  .add(
    HttpApiGroup.make("markdown-image-grants")
      .add(
        HttpApiEndpoint.post("grants", MarkdownImageGrantsPaths.grants, {
          params: { sessionID: SessionID },
          query: MarkdownImageGrantsQuery,
          payload: MarkdownImageGrantsPayload,
          success: described(MarkdownImageGrantsResponse, "Prepared markdown image grants"),
          error: [HttpApiError.BadRequest, MessageNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "markdownImageGrants.prepare",
            summary: "Prepare markdown image grants",
            description: "Validate and prepare grants for markdown images referenced in an assistant message.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "markdown-image-grants",
          description: "Grants for markdown media assets referenced in assistant messages.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode markdown-image-grants",
      version: "0.0.1",
      description: "Grants for markdown media assets.",
    }),
  )

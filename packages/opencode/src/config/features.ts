export * as ConfigFeatures from "./features"

import { Schema } from "effect"

export const McpFilePathBase64Encode = Schema.Struct({
  enable: Schema.optional(Schema.Boolean).annotate({
    description: "Master switch for MCP file path base64 encoding. true activates inclusion logic; false disables all file-path resolution",
  }),
  includeMCP: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "MCP server names (client keys from opencode.json) whose tools should get base64-encoded file paths",
  }),
}).annotate({ identifier: "McpFilePathBase64EncodeConfig" })

export const Info = Schema.Struct({
  mcpFilePathBase64Encode: Schema.optional(McpFilePathBase64Encode),
}).annotate({ identifier: "FeaturesConfig" })

import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"

// Observed repo error grammar (server middleware + storage/db.ts precedents):
// a rejected route body is { name, data: { ... } } — NamedError.toObject() / TaggedError shapes.
// The inspector's hard-fail config error surfaces with exactly this shape (AC2/AC4):
// it is an ERROR response carrying actionable, codeable detail — never a partial config.
// ConfigError documents the data shape; the response builder constructs the literal body
// (the raw-route composition owns status, so no httpApiStatus applies here).

export const SESSION_INSPECTOR_CONFIG_ERROR_NAME = "SessionInspectorConfigError"

export const ConfigError = NamedError.create(SESSION_INSPECTOR_CONFIG_ERROR_NAME, {
  message: Schema.String,
  code: Schema.String,
  path: Schema.String,
})

export type ConfigErrorInstance = InstanceType<typeof ConfigError>

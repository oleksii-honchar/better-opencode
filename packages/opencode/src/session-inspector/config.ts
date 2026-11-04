import { InspectorUserConfigFileSchema, defaultInspectorConfig } from "./config.schema"
import type { InspectorUserConfigFile, SessionInspectorConfig } from "./config.schema"

// Reads the user override file (if any) through an injected IO seam and produces the merged
// effective config — Result-style, never throws (no throws may reach a request handler).
// §6.5 / DEC-I: missing file = defaults + explicit warning marker; present-but-invalid = HARD FAIL.

export interface InspectorBaseDirs {
  configDir: string
  agentsDir: string
  logsDir: string
}

export type ConfigIO = {
  read: (path: string) => { kind: "ok"; text: string } | { kind: "missing" } | { kind: "error"; message: string }
}

export interface ConfigWarning {
  code: "CONFIG_FILE_MISSING"
  message: string
  path: string
}

export type ConfigFailureCode = "CONFIG_INVALID_JSON" | "CONFIG_INVALID_SCHEMA" | "CONFIG_UNREADABLE"

export type ConfigFailure = { ok: false; code: ConfigFailureCode; message: string; path: string }
export type ConfigSuccess = { ok: true; config: SessionInspectorConfig; warning?: ConfigWarning }
export type ConfigResult = ConfigSuccess | ConfigFailure

export interface LoadInspectorConfigInput {
  configPath: string
  io: ConfigIO
  baseDirs: InspectorBaseDirs
}

function formatIssues(error: { issues: readonly unknown[] }): string {
  return error.issues
    .map((raw) => {
      const issue = raw as { path?: readonly unknown[]; message?: string; code?: string; keys?: readonly string[] }
      const pathText = (issue.path ?? []).map((part) => String(part)).join(".")
      const detail =
        issue.code === "unrecognized_keys" && issue.keys !== undefined
          ? `unknown key(s): ${issue.keys.join(", ")} (${issue.message ?? "unrecognized"})`
          : (issue.message ?? "invalid value")
      return pathText.length > 0 ? `${pathText}: ${detail}` : detail
    })
    .join("\n")
}

function hardFailure(input: LoadInspectorConfigInput, code: ConfigFailureCode, detail: string): ConfigFailure {
  return {
    ok: false,
    code,
    message:
      `Session inspector config is present but invalid at ${input.configPath}. ${detail}\n` +
      `Fix the file or remove it to fall back to built-in defaults. The inspector never runs with a partial config.`,
    path: input.configPath,
  }
}

export function loadInspectorConfig(input: LoadInspectorConfigInput): ConfigResult {
  const defaults = defaultInspectorConfig({ agentsRoot: input.baseDirs.agentsDir, logsDir: input.baseDirs.logsDir })

  const read = (() => {
    try {
      return input.io.read(input.configPath)
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) } as const
    }
  })()

  if (read.kind === "missing") {
    return {
      ok: true,
      config: defaults,
      warning: {
        code: "CONFIG_FILE_MISSING",
        path: input.configPath,
        message:
          `No session inspector config found at ${input.configPath}. ` +
          `Serving built-in defaults; create the file to override categories, cell sizes, paths, or limits.`,
      },
    }
  }

  if (read.kind === "error") {
    return hardFailure(input, "CONFIG_UNREADABLE", `Reading failed: ${read.message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch (error) {
    return hardFailure(input, "CONFIG_INVALID_JSON", `It is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  const validated = InspectorUserConfigFileSchema.safeParse(parsed)
  if (!validated.success) {
    return hardFailure(input, "CONFIG_INVALID_SCHEMA", `Schema validation failed:\n${formatIssues(validated.error)}`)
  }

  return { ok: true, config: mergeSections(defaults, validated.data) }
}

// Section-replacement merge: an absent section keeps the default object as-is; a present section
// replaces that section wholesale (see config.schema.ts header).
function mergeSections(defaults: SessionInspectorConfig, override: InspectorUserConfigFile): SessionInspectorConfig {
  return {
    version: defaults.version,
    categories: override.categories ?? defaults.categories,
    cell: override.cell ?? defaults.cell,
    paths: override.paths ?? defaults.paths,
    limits: override.limits ?? defaults.limits,
    emitters: override.emitters ?? defaults.emitters,
  }
}

import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { ConfigMCP } from "../config/mcp"
import * as Agent from "../agent/agent"
import * as Log from "@opencode-ai/core/util/log"
import { NamedError } from "@opencode-ai/core/util/error"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { withTimeout } from "@/util/timeout"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { guardedFetchFn } from "./fetch-guard"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"
import { Effect, Exit, Layer, Option, Context, Schema, Stream } from "effect"
import { readFileSync, statSync } from "node:fs"
import { EffectBridge } from "@/effect/bridge"
import { resolve as resolveAttachment } from "@/session/attachment"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LenientJsonSchemaValidator } from "./lenient-validator"

const log = Log.create({ service: "mcp" })
const DEFAULT_TIMEOUT = 30_000

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = BusEvent.define(
  "mcp.tools.changed",
  Schema.Struct({
    server: Schema.String,
  }),
)

export const BrowserOpenFailed = BusEvent.define(
  "mcp.browser.open.failed",
  Schema.Struct({
    mcpName: Schema.String,
    url: Schema.String,
  }),
)

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

type MCPClient = Client

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, TransportWithAuth>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type McpEntry = NonNullable<Config.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCP.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

function remoteURL(key: string, value: string) {
  if (URL.canParse(value)) return new URL(value)
  log.warn("invalid remote mcp url", { key })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

function listTools(key: string, client: MCPClient, timeout: number) {
  return Effect.tryPromise({
    try: () => client.listTools(undefined, { timeout }),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((error) => {
      if (!isOutputSchemaValidationError(error)) return Effect.fail(error)

      log.warn("failed to validate MCP tool output schemas, retrying without output schema validation", { key, error })
      return Effect.tryPromise({
        try: () =>
          client.request({ method: "tools/list" }, TolerantListToolsResultSchema, {
            timeout,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.map((result) =>
          result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ),
      )
    }),
  )
}

/**
 * Build a JSON Schema for a tool input, with a safety net for empty/missing properties.
 *
 * When the input schema has no properties (empty object or missing field),
 * `additionalProperties` is set to `true` to avoid rejecting LLM-generated
 * arguments that don't match any defined property (which would make the
 * hallucination problem worse). When properties are present and non-empty,
 * the default is `additionalProperties: false`, preserving strict validation.
 */
export function buildToolSchema(inputSchema: JSONSchema7): JSONSchema7 {
  const schema = { ...inputSchema, type: "object" as const }
  const hasProperties =
    !!schema.properties && Object.keys(schema.properties).length > 0

  if (!hasProperties) {
    return {
      ...schema,
      properties: {},
      additionalProperties: true,
    }
  }

  return {
    ...schema,
    properties: schema.properties as JSONSchema7["properties"],
    additionalProperties: schema.additionalProperties ?? false,
  }
}

// Convert MCP tool definition to AI SDK Tool type
export function convertMcpTool(
  mcpTool: MCPToolDef,
  client: MCPClient,
  timeout?: number,
  toolOptions?: {
    mcpServerName?: string
    features?: {
      mcpFilePathBase64Encode?: {
        enable?: boolean
        includeMCP?: string[]
      }
    }
  },
): Tool {
  const inputSchema = mcpTool.inputSchema
  const schema = buildToolSchema(inputSchema as JSONSchema7)

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown) => {
      // Build attachment resolution options from toolOptions
      const feat = toolOptions?.features?.mcpFilePathBase64Encode
      const attachmentOptions: AttachmentResolutionOptions = {
        currentMcpServer: toolOptions?.mcpServerName,
        featureEnabled: feat?.enable ?? true,
        includeMCP: feat?.includeMCP,
      }
      const resolvedArgs = resolveAttachmentUris(args, attachmentOptions)
      const callParams = {
        name: mcpTool.name,
        arguments: (resolvedArgs || {}) as Record<string, unknown>,
      }
      log.debug("MCP tool execute", {
        toolName: mcpTool.name,
        argKeys: Object.keys(callParams.arguments),
        argTypes: typeof resolvedArgs,
      })
      return await client.callTool(
        callParams,
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          timeout,
        },
      )
    },
  })
}

/** Options controlling whether file paths are resolved to base64 for a given MCP server */
export interface AttachmentResolutionOptions {
  /** MCP server name (client key from opencode.json, e.g., "hugging-kreuzberg") */
  currentMcpServer?: string
  /** Only resolve file paths for these MCP server names */
  includeMCP?: string[]
  /** Feature master switch — when false, disables all file-path resolution */
  featureEnabled?: boolean
}

/**
 * Inclusion gate: should we resolve this file path to base64?
 * No options → legacy behavior (resolve everything).
 * Feature disabled → no resolution at all.
 * Empty/unset includeMCP → legacy fallback (resolve all).
 * Server in include list → resolve.
 * Server NOT in include list → skip resolution.
 */
function shouldResolveFilePath(options?: AttachmentResolutionOptions): boolean {
  if (!options) return true
  if (options.featureEnabled === false) return false
  if (!options.includeMCP || options.includeMCP.length === 0) return true
  if (options.includeMCP.includes(options.currentMcpServer ?? "")) return true
  return false
}

/**
 * Recursively resolves opencode://attachment URIs and absolute file paths
 * in args to base64 strings. Walks the entire arg tree (objects, arrays)
 * and replaces any URI string with its base64 content from the temp file store,
 * and any absolute file path with the base64-encoded file content.
 *
 * File paths are limited to 10MB; errors are thrown with details.
 * When options are provided, file-path resolution is gated by inclusion rules.
 */
export function resolveAttachmentUris(args: unknown, options?: AttachmentResolutionOptions): unknown {
  if (typeof args === "string") {
    if (args.startsWith("opencode://attachment/")) {
      const base64 = resolveAttachment(args)
      if (base64) {
        log.debug("resolved attachment URI", { uri: args, size: base64.length })
        return base64
      }
      // If not found, keep original — the tool will handle the error
      log.warn("attachment URI not resolved", { uri: args })
    } else if (args.startsWith("/") && shouldResolveFilePath(options)) {
      // Detect absolute file paths and convert to base64.
      // Only convert if the file actually exists — non-existent paths
      // may be write destinations (e.g., screenshot filePath) and should
      // pass through unchanged.
      try {
        const stat = statSync(args)
        if (stat.isDirectory()) {
          return args
        }
        if (!stat.isFile()) {
          throw new Error(`Not a regular file: ${args}`)
        }
        if (stat.size > 10 * 1024 * 1024) {
          throw new Error(`File too large (${stat.size} bytes, max 10MB): ${args}`)
        }
        const buffer = readFileSync(args)
        const base64 = buffer.toString("base64")
        log.debug("resolved file path to base64", { path: args, size: base64.length })
        return base64
      } catch (err) {
        // Pass through non-existent paths (likely write destinations)
        const error = err instanceof Error ? err : new Error("Unknown error")
        if (error.message.includes("ENOENT")) {
          return args
        }
        log.warn("file path resolution failed", { path: args, error: error.message })
        throw new Error(`Failed to read file: ${args} — ${error.message}`)
      }
    }
    return args
  }
  if (Array.isArray(args)) {
    return args.map((v) => resolveAttachmentUris(v, options))
  }
  if (args !== null && typeof args === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      result[key] = resolveAttachmentUris(value, options)
    }
    return result
  }
  return args // number, boolean, null — pass through
}

function defs(key: string, client: MCPClient, timeout?: number) {
  return listTools(key, client, timeout ?? DEFAULT_TIMEOUT).pipe(
    Effect.catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return Effect.succeed(undefined)
    }),
  )
}

function fetchFromClient<T extends { name: string }>(
  clientName: string,
  client: Client,
  listFn: (c: Client) => Promise<T[]>,
  label: string,
) {
  return Effect.tryPromise({
    try: () => listFn(client),
    catch: (e: any) => {
      log.error(`failed to get ${label}`, { clientName, error: e.message })
      return e
    },
  }).pipe(
    Effect.map((items) => {
      const out: Record<string, T & { client: string }> = {}
      const sanitizedClient = sanitize(clientName)
      for (const item of items) {
        out[sanitizedClient + ":" + sanitize(item.name)] = { ...item, client: clientName }
      }
      return out
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
}

export interface McpToolsCorrelation {
  readonly sessionId?: string
}

export interface McpFilteringDiagnosticInput extends McpToolsCorrelation {
  readonly agent?: string
  readonly allowedCategories?: readonly string[]
  readonly serverCategory?: string
  readonly excludedServerCount: number
  readonly excludedToolCount: number
}

export function mcpFilteringDiagnostic(input: McpFilteringDiagnosticInput): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    agent: input.agent,
    allowedCategories: input.allowedCategories,
    serverCategory: input.serverCategory,
    excludedServerCount: input.excludedServerCount,
    excludedToolCount: input.excludedToolCount,
  }
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly tools: (agent?: Agent.Info, correlation?: McpToolsCorrelation) => Effect.Effect<Record<string, Tool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCP.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status, NotFoundError>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const bus = yield* Bus.Service

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = (transport: Transport, timeout: number) =>
      Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = new Client({ name: "opencode", version: InstallationVersion }, { jsonSchemaValidator: new LenientJsonSchemaValidator() })
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "remote" },
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const url = remoteURL(key, mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
        }
      }
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callbackPort,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
            },
          },
          auth,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
            fetch: guardedFetchFn(url),
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              log.info("mcp server requires authentication", { key, transport: name })

              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                pendingOAuthTransports.set(key, transport)
                lastStatus = { status: "needs_auth" as const }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            log.debug("transport connection failed", {
              key,
              transport: name,
              url: mcp.url,
              error: lastError.message,
            })
            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.succeed(undefined)
          }),
        )
        if (result) {
          log.info("connected", { key, transport: result.transportName })
          return { client: result.client as MCPClient | undefined, status: { status: "connected" } as Status }
        }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command
      const cwd = yield* InstanceState.directory
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          log.error("local mcp startup failed", { key, command: mcp.command, cwd, error: msg })
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(function* (key: string, mcp: ConfigMCP.Info) {
      if (mcp.enabled === false) {
        log.info("mcp server disabled", { key })
        return DISABLED_RESULT
      }

      log.info("found", { key, type: mcp.type })

      const { client: mcpClient, status } =
        mcp.type === "remote"
          ? yield* connectRemote(key, mcp as ConfigMCP.Info & { type: "remote" })
          : yield* connectLocal(key, mcp as ConfigMCP.Info & { type: "local" })

      if (!mcpClient) {
        return { status } satisfies CreateResult
      }

      const listed = yield* defs(key, mcpClient, mcp.timeout)
      if (!listed) {
        yield* Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore)
        return { status: { status: "failed", error: "Failed to get tools" } } satisfies CreateResult
      }

      log.info("create() successfully created client", { key, toolCount: listed.length })
      return { mcpClient, status, defs: listed } satisfies CreateResult
    })
    const cfgSvc = yield* Config.Service

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        while (queue.length > 0) {
          const current = queue.shift()!
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        log.info("tools list changed notification received", { server: name })
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(defs(name, client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        const config = cfg.mcp ?? {}
        const s: State = {
          status: {},
          clients: {},
          defs: {},
        }

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                log.error("Ignoring MCP config entry without type", { key })
                return
              }

              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              const result = yield* create(key, mcp).pipe(Effect.catch(() => Effect.void))
              if (!result) return

              s.status[key] = result.status
              if (result.mcpClient) {
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                watch(s, key, result.mcpClient, bridge, mcp.timeout)
              }
            }),
          { concurrency: "unbounded" },
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(
              Object.values(s.clients),
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                }),
              { concurrency: "unbounded" },
            )
            pendingOAuthTransports.clear()
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.defs[name]
      if (!client) return Effect.void
      return Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      timeout?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      yield* closeClient(s, name)
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      watch(s, name, client, bridge, timeout)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCP.Info) {
      const s = yield* InstanceState.get(state)
      const result = yield* create(name, mcp)

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name)
        delete s.clients[name]
        return result.status
      }

      return yield* storeClient(s, name, result.mcpClient, result.defs!, mcp.timeout)
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCP.Info) {
      yield* createAndStore(name, mcp)
      const s = yield* InstanceState.get(state)
      return { status: s.status }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      yield* createAndStore(name, { ...mcp, enabled: true })
      yield* bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
      yield* bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
    })

    const tools = Effect.fn("MCP.tools")(function* (agent?: Agent.Info, correlation?: McpToolsCorrelation) {
      const result: Record<string, Tool> = {}
      const s = yield* InstanceState.get(state)
      const filterContext = {
        sessionId: correlation?.sessionId,
        agent: agent?.name,
        allowedCategories: agent?.allowedMcpCategories,
      }

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      const allowedCategories = agent?.allowedMcpCategories
      if (!allowedCategories) {
        // No agent or no allowedMcpCategories — load all tools (backward-compatible)
      }

      const connectedClients = Object.entries(s.clients).filter(
        ([clientName]) => s.status[clientName]?.status === "connected",
      )

      yield* Effect.forEach(
        connectedClients,
        ([clientName, client]) =>
          Effect.gen(function* () {
            const mcpConfig = config[clientName]
            const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : undefined

            const listed = s.defs[clientName]
            if (!listed) {
              log.warn("missing cached tools for connected server", { clientName })
              return
            }

            // Filter by category if agent has allowedMcpCategories
            const serverCategory = entry?.category
            if (allowedCategories && serverCategory && !allowedCategories.includes(serverCategory)) {
              log.debug("skipping MCP server (category mismatch)", {
                server: clientName,
                category: serverCategory,
                allowed: allowedCategories,
                ...mcpFilteringDiagnostic({
                  ...filterContext,
                  serverCategory,
                  excludedServerCount: 1,
                  excludedToolCount: listed.length,
                }),
              })
              return
            }

            // Filter by enabledTools (whitelist) and disabledTools (blacklist)
            const enabledTools = entry?.enabledTools
            const disabledTools = entry?.disabledTools

            if (enabledTools || disabledTools) {
              // Mutual exclusion: if both specified, prefer enabledTools
              if (enabledTools && disabledTools) {
                log.warn("MCP config has both enabledTools and disabledTools — using enabledTools only", {
                  clientName,
                })
              }

              const toolFilter = enabledTools ?? disabledTools
              const isWhitelist = !!enabledTools

              const filteredTools = listed.filter((mcpTool) => {
                if (isWhitelist) {
                  return toolFilter!.includes(mcpTool.name)
                }
                // Blacklist: include if NOT in disabled list
                return !toolFilter!.includes(mcpTool.name)
              })

              if (filteredTools.length === 0) {
                const listedNames = listed.map((t) => t.name)
                log.warn("all tools filtered out for MCP server", {
                  clientName,
                  enabledTools,
                  disabledTools,
                  filter: isWhitelist ? "enabledTools" : "disabledTools",
                  expectedToolNames: toolFilter,
                  receivedToolNames: listedNames,
                  ...mcpFilteringDiagnostic({
                    ...filterContext,
                    serverCategory,
                    excludedServerCount: 0,
                    excludedToolCount: listed.length,
                  }),
                  hint: isWhitelist
                    ? `enabledTools names must match the tool names returned by the server. For remote servers proxied through LiteLLM (/mcp/<server>), tools are prefixed with "<server>-" (e.g. paperless-list_documents, hugging_kreuzberg-extract_bytes)`
                    : "disabledTools names must match the tool names returned by the server",
                })
                return
              }

              const timeout = entry?.timeout ?? defaultTimeout
              for (const mcpTool of filteredTools) {
                const toolKey = sanitize(clientName) + "_" + sanitize(mcpTool.name)
                result[toolKey] = convertMcpTool(mcpTool, client, timeout, {
                  mcpServerName: clientName,
                  features: cfg.features,
                })
                ;(result[toolKey] as any).server = clientName
              }

              log.debug("MCP tools filtered", {
                clientName,
                original: listed.length,
                filtered: filteredTools.length,
                filter: isWhitelist ? "enabledTools" : "disabledTools",
                count: filteredTools.length,
                ...mcpFilteringDiagnostic({
                  ...filterContext,
                  serverCategory,
                  excludedServerCount: 0,
                  excludedToolCount: listed.length - filteredTools.length,
                }),
              })
            } else {
              // No tool filtering — use original listed tools
              const timeout = entry?.timeout ?? defaultTimeout
              for (const mcpTool of listed) {
                const toolKey = sanitize(clientName) + "_" + sanitize(mcpTool.name)
                result[toolKey] = convertMcpTool(mcpTool, client, timeout, {
                  mcpServerName: clientName,
                  features: cfg.features,
                })
                ;(result[toolKey] as any).server = clientName
              }
            }
          }),
        { concurrency: "unbounded" },
      )
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client) => Promise<T[]>,
      label: string,
    ) {
      return Effect.forEach(
        Object.entries(s.clients).filter(([name]) => s.status[name]?.status === "connected"),
        ([clientName, client]) =>
          fetchFromClient(clientName, client, listFn, label).pipe(Effect.map((items) => Object.entries(items ?? {}))),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listPrompts().then((r) => r.prompts), "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listResources().then((r) => r.resources), "resources")
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        log.warn(`client not found for ${label}`, { clientName })
        return undefined
      }
      return yield* Effect.tryPromise({
        try: () => fn(client),
        catch: (e: any) => {
          log.error(`failed to ${label}`, { clientName, ...meta, error: e?.message })
          return e
        },
      }).pipe(Effect.orElseSucceed(() => undefined))
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(clientName, (client) => client.getPrompt({ name, arguments: args }), "getPrompt", {
        promptName: name,
      })
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(clientName, (client) => client.readResource({ uri: resourceUri }), "readResource", {
        resourceUri,
      })
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const url = remoteURL(mcpName, mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Resolve effective redirect URI: explicit redirectUri > callbackPort shorthand > default
      const effectiveRedirectUri =
        oauthConfig?.redirectUri ??
        (oauthConfig?.callbackPort ? `http://127.0.0.1:${oauthConfig.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined)

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: effectiveRedirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(url, {
        authProvider,
        fetch: guardedFetchFn(url),
      })

      return yield* Effect.tryPromise({
        try: () => {
          const client = new Client({ name: "opencode", version: InstallationVersion }, { jsonSchemaValidator: new LenientJsonSchemaValidator() })
          return client
            .connect(transport)
            .then(() => ({ authorizationUrl: "", oauthState, client }) satisfies AuthResult)
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, transport)
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (mcpName: string) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* requireMcpConfig(mcpName).pipe(
          Effect.tapError(() => Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)),
        )

        const listed = client ? yield* defs(mcpName, client, mcpConfig.timeout) : undefined
        if (!client || !listed) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "Failed to get tools" } as Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(s, mcpName, client, listed, mcpConfig.timeout)
      }

      log.info("opening browser for oauth", { mcpName, url: result.authorizationUrl, state: result.oauthState })

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)

      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          log.warn("failed to open browser, user must open URL manually", { mcpName })
          return bus.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      yield* requireMcpConfig(mcpName)
      const transport = pendingOAuthTransports.get(mcpName)
      if (!transport) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const result = yield* Effect.tryPromise({
        try: () => transport.finishAuth(authorizationCode).then(() => true as const),
        catch: (error) => {
          log.error("failed to finish oauth", { mcpName, error })
          return error
        },
      }).pipe(Effect.option)

      if (Option.isNone(result)) {
        return { status: "failed", error: "OAuth completion failed" } as Status
      }

      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* requireMcpConfig(mcpName)

      return yield* createAndStore(mcpName, mcpConfig)
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
      log.info("removed oauth credentials", { mcpName })
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      if (!entry?.tokens) return "not_authenticated" as AuthStatus
      const expired = yield* auth.isTokenExpired(mcpName)
      return (expired ? "expired" : "authenticated") as AuthStatus
    })

    return Service.of({
      status,
      clients,
      tools,
      prompts,
      resources,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

export const defaultLayer = layer.pipe(
  Layer.provide(McpAuth.layer),
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as MCP from "."

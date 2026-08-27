/**
 * Regression test for the guardedFetchFn transport wiring (spec C2).
 *
 * Mocks the SDK transport classes with spies so we can assert what options
 * the MCP service passes to `StreamableHTTPClientTransport` at the
 * `connectRemote` (via `MCP.connect`) and `startAuth` construction sites:
 * the transport must receive the guarded fetch via the SDK's public `fetch`
 * option (forwarded into the SDK's internal auth-chain `fetchFn`) while
 * retaining `authProvider`.
 */
import { describe, test, expect, mock, afterEach } from "bun:test"

const SERVER_URL = "https://mcp.example.com/mcp"

const streamableArgs: Array<{ url: unknown; opts: Record<string, unknown> }> = []
const sseArgs: Array<{ url: unknown; opts: Record<string, unknown> }> = []

class MockStreamableHTTPClientTransport {
  constructor(url: unknown, opts: Record<string, unknown>) {
    streamableArgs.push({ url, opts })
  }
  async start(): Promise<void> {
    throw new TypeError("mock transport not implemented")
  }
  async send(): Promise<void> {
    throw new TypeError("mock transport not implemented")
  }
  async close(): Promise<void> {}
}

class MockSSEClientTransport {
  constructor(url: unknown, opts: Record<string, unknown>) {
    sseArgs.push({ url, opts })
  }
  async start(): Promise<void> {
    throw new TypeError("mock transport not implemented")
  }
  async send(): Promise<void> {
    throw new TypeError("mock transport not implemented")
  }
  async close(): Promise<void> {}
}

// Mock the SDK transport modules BEFORE importing the MCP service.
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
}))
mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSEClientTransport,
}))

import { Effect, Layer, Exit } from "effect"
import * as MCP from "./index"
import { McpAuth } from "./auth"
import { McpOAuthProvider } from "./oauth-provider"
import { Config } from "@/config/config"
import { emptyConsoleState } from "@/config/console-state"
import { Bus } from "@/bus"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceRef } from "@/effect/instance-ref"
import { ProjectID } from "@/project/schema"
import type { InstanceContext } from "@/project/instance-context"

const instanceContextStub: InstanceContext = {
  directory: "/tmp",
  worktree: "/tmp",
  project: { id: ProjectID.global, worktree: "/tmp", time: { created: 0, updated: 0 }, sandboxes: [] },
}

const authStub: McpAuth.Interface = {
  all: () => Effect.succeed({}),
  get: (_mcpName) => Effect.succeed(undefined),
  getForUrl: (_mcpName, _serverUrl) => Effect.succeed(undefined),
  set: (_mcpName, _entry, _serverUrl) => Effect.succeed(undefined),
  remove: (_mcpName) => Effect.succeed(undefined),
  updateTokens: (_mcpName, _tokens, _serverUrl) => Effect.succeed(undefined),
  updateClientInfo: (_mcpName, _clientInfo, _serverUrl) => Effect.succeed(undefined),
  updateCodeVerifier: (_mcpName, _codeVerifier) => Effect.succeed(undefined),
  clearCodeVerifier: (_mcpName) => Effect.succeed(undefined),
  updateOAuthState: (_mcpName, _oauthState) => Effect.succeed(undefined),
  getOAuthState: (_mcpName) => Effect.succeed(undefined),
  clearOAuthState: (_mcpName) => Effect.succeed(undefined),
  isTokenExpired: (_mcpName) => Effect.succeed(null),
}

const configStub: Config.Interface = {
  get: () => Effect.succeed({ mcp: { "test-server": { type: "remote", url: SERVER_URL } } }),
  getGlobal: () => Effect.succeed({}),
  getConsoleState: () => Effect.succeed(emptyConsoleState),
  update: (_config) => Effect.succeed(undefined),
  updateGlobal: (_config) => Effect.succeed({ info: {}, changed: false }),
  invalidate: () => Effect.succeed(undefined),
  directories: () => Effect.succeed([]),
  waitForDependencies: () => Effect.succeed(undefined),
}

const testLayer = MCP.layer.pipe(
  Layer.provide(Layer.succeed(McpAuth.Service, authStub)),
  Layer.provide(Layer.succeed(Config.Service, configStub)),
  Layer.provide(Bus.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)

async function withMcpService<A>(effect: Effect.Effect<A, unknown, MCP.Service>): Promise<A> {
  return await Effect.runPromise(
    Effect.provide(effect, testLayer).pipe(Effect.provideService(InstanceRef, instanceContextStub)),
  )
}

describe("MCP transport wiring (guardedFetchFn)", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("connectRemote passes the guarded fetch + authProvider to StreamableHTTPClientTransport", async () => {
    await withMcpService(MCP.use.connect("test-server"))

    const captured = streamableArgs.at(-1)
    expect(captured).toBeDefined()
    expect(captured!.url).toEqual(new URL(SERVER_URL))
    expect(typeof captured!.opts.fetch).toBe("function")
    expect(captured!.opts.authProvider).toBeInstanceOf(McpOAuthProvider)
  })

  test("startAuth passes the guarded fetch alongside the existing authProvider", async () => {
    const exit = await withMcpService(MCP.use.startAuth("test-server").pipe(Effect.exit))
    // The mock transport throws on connect, so startAuth dies — but only after
    // constructing the transport, which is what this test inspects.
    expect(Exit.isFailure(exit)).toBe(true)

    const captured = streamableArgs.at(-1)
    expect(captured).toBeDefined()
    expect(captured!.url).toEqual(new URL(SERVER_URL))
    expect(captured!.opts.authProvider).toBeInstanceOf(McpOAuthProvider)
    expect(typeof captured!.opts.fetch).toBe("function")
  })

  test("the wired fetch is the guard: empty 2xx body becomes a descriptive error, not a JSC parse crash", async () => {
    await withMcpService(MCP.use.connect("test-server"))

    const captured = streamableArgs.at(-1)
    expect(captured).toBeDefined()
    const guarded = captured!.opts.fetch as (
      input: URL | RequestInfo,
      init?: RequestInit,
    ) => Promise<Response>

    globalThis.fetch = mock(async () => new Response("", { status: 200, headers: { "content-length": "0" } })) as unknown as typeof fetch

    await expect(guarded(SERVER_URL)).rejects.toThrow(
      `MCP server ${SERVER_URL} returned an empty response body (HTTP 200)`,
    )
  })
})

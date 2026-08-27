/**
 * Unit tests for the `mcp auth` CLI usability helpers (spec C5):
 *  - I3a: `isMcpRemoteBridge` detection + bridge guidance hint in McpAuthCommand
 *  - I3b: SDK "does not support dynamic client registration" error surfaces the
 *    clientId hint instead of the opaque "Unexpected error" path
 */
import { describe, test, expect, mock, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { emptyConsoleState } from "@/config/console-state"
import { MCP } from "../../mcp"

// ---------------------------------------------------------------------------
// Mock @clack/prompts so we can assert what the command prints.
// ---------------------------------------------------------------------------

const logMessages: Array<{ level: string; message: string }> = []

function capture(level: string) {
  return (...args: Array<unknown>) => {
    logMessages.push({ level, message: args.map((a) => String(a)).join(" ") })
  }
}

mock.module("@clack/prompts", () => ({
  intro: capture("intro"),
  outro: capture("outro"),
  log: {
    warn: capture("warn"),
    info: capture("info"),
    error: capture("error"),
    success: capture("success"),
  },
  isCancel: () => false,
  select: async (opts: { options: Array<{ value: string }> }) => opts.options[0]?.value ?? undefined,
  confirm: async () => false,
  text: async () => undefined,
  password: async () => undefined,
  spinner: () => ({
    start: () => {},
    stop: (..._args: Array<unknown>) => {},
    message: () => {},
  }),
}))

// Bus is only used by the handler for the browser-open-failure subscription;
// a no-op is enough — the real bus needs InstanceState/InstanceRef wiring.
mock.module("../../bus", () => ({
  subscribe: () => () => {},
}))

// ---------------------------------------------------------------------------
// Import the command module AFTER the mocks are registered.
// ---------------------------------------------------------------------------

import { McpAuthCommand, isMcpRemoteBridge, mcpAuthCommand } from "./mcp"

beforeEach(() => {
  logMessages.length = 0
})

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BRIDGE_URL = "https://api.ibkr.com/v1/api/mcp-public"
const REMOTE_URL = "https://example.com/mcp"

const bridgeMcp: Config.Info["mcp"] = {
  "ibkr-U20943171": {
    type: "local",
    command: ["npx", "--prefer-offline", "-y", "mcp-remote@0.2.6", BRIDGE_URL],
  },
}

function makeConfigStub(mcp: Config.Info["mcp"]): Config.Interface {
  return {
    get: () => Effect.succeed({ mcp }),
    getGlobal: () => Effect.succeed({}),
    getConsoleState: () => Effect.succeed(emptyConsoleState),
    update: (_config) => Effect.succeed(undefined),
    updateGlobal: (_config) => Effect.succeed({ info: {}, changed: false }),
    invalidate: () => Effect.succeed(undefined),
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.succeed(undefined),
  }
}

function makeMcpStub(overrides: Partial<MCP.Interface> = {}): MCP.Interface {
  const succeed = <A, E = never>(value: A) => Effect.succeed(value) as Effect.Effect<A, E>
  const base: MCP.Interface = {
    status: () => succeed({}),
    clients: () => succeed({}),
    tools: () => succeed({}),
    prompts: () => succeed({}),
    resources: () => succeed({}),
    add: (_name, _mcp) => succeed({ status: {} }),
    connect: (_name) => succeed(undefined),
    disconnect: (_name) => succeed(undefined),
    getPrompt: () => succeed(undefined),
    readResource: () => succeed(undefined),
    startAuth: () => succeed({ authorizationUrl: "", oauthState: "" }),
    authenticate: (_name) => succeed({ status: "connected" }),
    finishAuth: (_name, _code) => succeed({ status: "connected" }),
    removeAuth: (_name) => succeed(undefined),
    supportsOAuth: (_name) => succeed(true),
    hasStoredTokens: (_name) => succeed(false),
    getAuthStatus: (_name) => succeed("not_authenticated" as MCP.AuthStatus),
  }
  return { ...base, ...overrides }
}

function withAuthCommand(
  config: Config.Info["mcp"],
  mcpStub: MCP.Interface,
): Promise<void> {
  const layer = Layer.merge(
    Layer.succeed(Config.Service, makeConfigStub(config)),
    Layer.succeed(MCP.Service, mcpStub),
  )
  return Effect.runPromise(Effect.provide(mcpAuthCommand({ name: undefined }), layer))
}

function messages(level: string): string[] {
  return logMessages.filter((m) => m.level === level).map((m) => m.message)
}

function allMessages(): string[] {
  return logMessages.map((m) => m.message)
}

// ---------------------------------------------------------------------------
// I3a — isMcpRemoteBridge
// ---------------------------------------------------------------------------

describe("isMcpRemoteBridge", () => {
  test("true for a local config whose command contains mcp-remote and a URL arg", () => {
    expect(isMcpRemoteBridge(bridgeMcp!["ibkr-U20943171"])).toBe(true)
  })

  test("false for a local server with no mcp-remote token", () => {
    expect(
      isMcpRemoteBridge({
        type: "local",
        command: ["npx", "filesystem", "/tmp"],
      }),
    ).toBe(false)
  })

  test("false for a local server with an mcp-remote token but no URL arg", () => {
    expect(
      isMcpRemoteBridge({
        type: "local",
        command: ["mcp-remote", "--flag-only"],
      }),
    ).toBe(false)
  })

  test("false when the URL appears before the mcp-remote token (must be a later arg)", () => {
    expect(
      isMcpRemoteBridge({
        type: "local",
        command: [BRIDGE_URL, "mcp-remote"],
      }),
    ).toBe(false)
  })

  test("false for a type remote server", () => {
    expect(isMcpRemoteBridge({ type: "remote", url: REMOTE_URL })).toBe(false)
  })

  test("false for a non-object entry", () => {
    expect(isMcpRemoteBridge("npx" as never)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// I3a — McpAuthCommand bridge guidance
// ---------------------------------------------------------------------------

describe("McpAuthCommand bridge guidance (I3a)", () => {
  test("with zero oauthServers and >=1 mcp-remote bridge, prints guidance naming mcp-remote@0.2.6 and the bridge URL; exit 0", async () => {
    await withAuthCommand(bridgeMcp, makeMcpStub())

    const printed = allMessages()
    expect(printed.some((m) => m.includes("mcp-remote@0.2.6"))).toBe(true)
    expect(printed.some((m) => m.includes(BRIDGE_URL))).toBe(true)
  })

  test("with zero oauthServers and no bridges, prints the existing no-op (unchanged behavior)", async () => {
    await withAuthCommand({ "local-only": { type: "local", command: ["npx", "filesystem", "/tmp"] } }, makeMcpStub())

    const printed = allMessages()
    expect(printed.some((m) => m.includes("No OAuth-capable MCP servers configured"))).toBe(true)
    expect(printed.some((m) => m.includes("mcp-remote@0.2.6"))).toBe(false)
  })

  test("with zero oauthServers and zero configured servers at all, prints the existing no-op", async () => {
    await withAuthCommand({}, makeMcpStub())

    const printed = allMessages()
    expect(printed.some((m) => m.includes("No OAuth-capable MCP servers configured"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// I3b — registration error mapping
// ---------------------------------------------------------------------------

describe("McpAuthCommand registration error mapping (I3b)", () => {
  test("SDK 'does not support dynamic client registration' error surfaces the clientId hint, not the opaque Unexpected error path", async () => {
    const remoteMcp: Config.Info["mcp"] = {
      "test-server": { type: "remote", url: REMOTE_URL, oauth: {} },
    }
    const mcpStub = makeMcpStub({
      authenticate: () =>
        Effect.die(
          new Error("Incompatible auth server: authorization server does not support dynamic client registration"),
        ),
    })

    // The effect must catch the known class (exit 0), not propagate a die.
    await withAuthCommand(remoteMcp, mcpStub)

    const printed = allMessages()
    expect(printed.some((m) => m.includes("does not support dynamic client registration"))).toBe(true)
    expect(printed.some((m) => m.includes("Add clientId to your MCP server config:"))).toBe(true)
  })
})
// Keep a reference to the exported command object so the import is not flagged.
void McpAuthCommand

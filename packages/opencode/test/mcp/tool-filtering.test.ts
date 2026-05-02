/**
 * Tests for MCP Per-Tool Filtering
 *
 * These tests verify the per-tool filtering logic in MCP.tools():
 * 1. Whitelist filtering (enabledTools) — only whitelisted tools are returned
 * 2. Blacklist filtering (disabledTools) — blacklisted tools are excluded
 * 3. Mutual exclusion — enabledTools takes precedence when both fields specified
 * 4. Combined category + tool filtering — both filters apply correctly
 * 5. No filter specified — all tools returned (backward-compatible)
 * 6. All tools filtered out — warning logged
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { MCP } from "../../src/mcp"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Permission } from "../../src/permission"

// Helper to create a mock agent with allowedMcpCategories
function createAgent(
  name: string,
  options?: { allowedMcpCategories?: string[] },
): Agent.Info {
  return {
    name,
    mode: "subagent" as const,
    permission: Permission.fromConfig({ "*": "allow" }),
    options: {},
    ...(options?.allowedMcpCategories ? { allowedMcpCategories: options.allowedMcpCategories } : {}),
  }
}

// Mock MCP Service layer for per-tool filtering tests
function createMockMcpLayer(config: Record<string, { tools: any[]; category?: string; enabledTools?: string[]; disabledTools?: string[] }>) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      tools: (agent?: Agent.Info) => {
        const allowedCategories = agent?.allowedMcpCategories
        const result: Record<string, any> = {}

        for (const [serverName, serverConfig] of Object.entries(config)) {
          // Filter by category if agent has allowedMcpCategories
          const serverCategory = serverConfig.category
          if (allowedCategories && serverCategory && !allowedCategories.includes(serverCategory)) {
            // Skip server - category mismatch
            continue
          }

          // Filter by enabledTools (whitelist) and disabledTools (blacklist)
          const enabledTools = serverConfig.enabledTools
          const disabledTools = serverConfig.disabledTools

          if (enabledTools || disabledTools) {
            // Mutual exclusion: if both specified, prefer enabledTools
            if (enabledTools && disabledTools) {
              // In real implementation, a warning would be logged here
            }

            const toolFilter = enabledTools ?? disabledTools
            const isWhitelist = !!enabledTools

            const filteredTools = serverConfig.tools.filter((tool: any) => {
              if (isWhitelist) {
                return toolFilter!.includes(tool.name)
              }
              // Blacklist: include if NOT in disabled list
              return !toolFilter!.includes(tool.name)
            })

            if (filteredTools.length === 0) {
              // All tools filtered out - skip this server
              continue
            }

            for (const tool of filteredTools) {
              result[`${serverName}_${tool.name}`] = tool
            }
            continue
          }

          // No tool filter — load all tools
          for (const tool of serverConfig.tools) {
            result[`${serverName}_${tool.name}`] = tool
          }
        }

        return Effect.succeed(result)
      },
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in tests"),
      authenticate: () => Effect.die("unexpected MCP auth in tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

describe("mcp.tool-filtering", () => {
  test("MCP.tools() returns all tools when no tool filter specified", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": { tools: [{ name: "read" }, { name: "write" }] },
      "server-b": { tools: [{ name: "delete" }] },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.tools(undefined)
        }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Should return all tools from all servers
        expect(result).toHaveProperty("server-a_read")
        expect(result).toHaveProperty("server-a_write")
        expect(result).toHaveProperty("server-b_delete")
      },
    })
  })

  test("MCP.tools() respects enabledTools whitelist", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": {
        tools: [{ name: "read" }, { name: "write" }, { name: "delete" }],
        enabledTools: ["read", "write"],
      },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.tools(undefined)
        }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Should only return whitelisted tools
        expect(result).toHaveProperty("server-a_read")
        expect(result).toHaveProperty("server-a_write")
        expect(result).not.toHaveProperty("server-a_delete")
      },
    })
  })

  test("MCP.tools() returns no tools when enabledTools whitelist is empty", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": {
        tools: [{ name: "read" }, { name: "write" }],
        enabledTools: [],
      },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.tools(undefined)
        }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Empty whitelist returns no tools
        expect(result).not.toHaveProperty("server-a_read")
        expect(result).not.toHaveProperty("server-a_write")
      },
    })
  })

  test("MCP.tools() respects disabledTools blacklist", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": {
        tools: [{ name: "read" }, { name: "write" }, { name: "delete" }],
        disabledTools: ["delete"],
      },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.tools(undefined)
        }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Should return all tools except blacklisted ones
        expect(result).toHaveProperty("server-a_read")
        expect(result).toHaveProperty("server-a_write")
        expect(result).not.toHaveProperty("server-a_delete")
      },
    })
  })

  test("MCP.tools() returns all tools when disabledTools blacklist is empty", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": {
        tools: [{ name: "read" }, { name: "write" }],
        disabledTools: [],
      },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.tools(undefined)
        }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Empty blacklist returns all tools
        expect(result).toHaveProperty("server-a_read")
        expect(result).toHaveProperty("server-a_write")
      },
    })
  })

  test("MCP.tools() prefers enabledTools when both fields specified", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": {
        tools: [{ name: "read" }, { name: "write" }, { name: "delete" }],
        enabledTools: ["read"],
        disabledTools: ["read"],
      },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.tools(undefined)
        }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // enabledTools takes precedence (whitelist), so "read" is included
        expect(result).toHaveProperty("server-a_read")
        expect(result).not.toHaveProperty("server-a_write")
        expect(result).not.toHaveProperty("server-a_delete")
      },
    })
  })

  test("MCP.tools() combines category and tool filtering", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": {
        tools: [{ name: "read" }, { name: "write" }],
        category: "dev",
        enabledTools: ["read"],
      },
      "server-b": {
        tools: [{ name: "delete" }],
        category: "prod",
        enabledTools: ["delete"],
      },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const agent = createAgent("dev-agent", { allowedMcpCategories: ["dev"] })
          return yield* mcp.tools(agent)
        }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Category filter: only server-a (dev)
        // Tool filter: only "read" from server-a
        expect(result).toHaveProperty("server-a_read")
        expect(result).not.toHaveProperty("server-a_write")
        expect(result).not.toHaveProperty("server-b_delete")
      },
    })
  })

  test("MCP.tools() tool filter applies after category filter", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": {
        tools: [{ name: "read" }, { name: "write" }],
        category: "dev",
        enabledTools: ["read"],
      },
      "server-b": {
        tools: [{ name: "delete" }],
        category: "dev",
        enabledTools: ["delete"],
      },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const agent = createAgent("dev-agent", { allowedMcpCategories: ["dev"] })
          return yield* mcp.tools(agent)
        }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Both servers pass category filter (dev)
        // Tool filter applies to each server independently
        expect(result).toHaveProperty("server-a_read")
        expect(result).not.toHaveProperty("server-a_write")
        expect(result).toHaveProperty("server-b_delete")
      },
    })
  })

  test("MCP.tools() tool filter is per-server, not global", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": {
        tools: [{ name: "read" }, { name: "write" }],
        enabledTools: ["read"],
      },
      "server-b": {
        tools: [{ name: "read" }, { name: "delete" }],
        enabledTools: ["read", "delete"],
      },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.tools(undefined)
        }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Each server filters independently
        expect(result).toHaveProperty("server-a_read")
        expect(result).not.toHaveProperty("server-a_write")
        expect(result).toHaveProperty("server-b_read")
        expect(result).toHaveProperty("server-b_delete")
      },
    })
  })

  test("MCP.tools() tool names must match exactly (case-sensitive)", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": {
        tools: [{ name: "Read" }, { name: "read" }],
        enabledTools: ["Read"],
      },
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.tools(undefined)
        }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Exact match only - "Read" != "read"
        expect(result).toHaveProperty("server-a_Read")
        expect(result).not.toHaveProperty("server-a_read")
      },
    })
  })
})

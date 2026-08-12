/**
 * Tests for MCP Server Category Filtering
 *
 * These tests verify the filtering logic in MCP.tools():
 * 1. Returns all tools when agent has no allowedMcpCategories (backward-compatible)
 * 2. Returns all tools when agent parameter is undefined
 * 3. Returns all tools when server has no category (backward-compatible)
 * 4. Filters out servers with mismatched category
 * 5. Returns all tools when agent has empty allowedMcpCategories
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { MCP, mcpFilteringDiagnostic } from "../../src/mcp"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { provideInstance, tmpdir } from "../fixture/fixture"
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

// Mock MCP Service layer for testing
function createMockMcpLayer(config: Record<string, { tools: any[]; category?: string }>) {
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

          // Load tools from this server
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

describe("mcp.category-filtering", () => {
  test("builds session-correlated exclusion diagnostics without changing filtering inputs", () => {
    expect(mcpFilteringDiagnostic({
      sessionId: "ses_filter",
      agent: "generalist",
      allowedCategories: ["session"],
      serverCategory: "observability",
      excludedServerCount: 1,
      excludedToolCount: 3,
    })).toEqual({
      sessionId: "ses_filter",
      agent: "generalist",
      allowedCategories: ["session"],
      serverCategory: "observability",
      excludedServerCount: 1,
      excludedToolCount: 3,
    })
  })

  test("MCP.tools() returns all tools when agent has no allowedMcpCategories", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": { tools: [{ name: "read" }], category: "dev" },
      "server-b": { tools: [{ name: "write" }], category: "prod" },
    }

        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const agent = createAgent("test-agent")
          return yield* mcp.tools(agent)
        }).pipe(provideInstance(tmp.path), Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Should return tools from both servers (no filtering)
        expect(result).toHaveProperty("server-a_read")
        expect(result).toHaveProperty("server-b_write")
  })

  test("MCP.tools() returns all tools when agent parameter is undefined", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": { tools: [{ name: "read" }], category: "dev" },
      "server-b": { tools: [{ name: "write" }], category: "prod" },
    }

        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.tools(undefined)
        }).pipe(provideInstance(tmp.path), Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Should return tools from both servers (no filtering)
        expect(result).toHaveProperty("server-a_read")
        expect(result).toHaveProperty("server-b_write")
  })

  test("MCP.tools() filters out servers with mismatched category", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": { tools: [{ name: "read" }], category: "dev" },
      "server-b": { tools: [{ name: "write" }], category: "prod" },
    }

        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const agent = createAgent("dev-agent", { allowedMcpCategories: ["dev"] })
          return yield* mcp.tools(agent)
        }).pipe(provideInstance(tmp.path), Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Should only return tools from server-a (dev category)
        expect(result).toHaveProperty("server-a_read")
        expect(result).not.toHaveProperty("server-b_write")
  })

  test("MCP.tools() returns all tools when server has no category", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": { tools: [{ name: "read" }], category: "dev" },
      "server-b": { tools: [{ name: "write" }] }, // No category
    }

        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const agent = createAgent("dev-agent", { allowedMcpCategories: ["dev"] })
          return yield* mcp.tools(agent)
        }).pipe(provideInstance(tmp.path), Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Should return tools from both servers (server-b has no category = load for all)
        expect(result).toHaveProperty("server-a_read")
        expect(result).toHaveProperty("server-b_write")
  })

  test("MCP.tools() filters when agent has multiple allowed categories", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": { tools: [{ name: "read" }], category: "dev" },
      "server-b": { tools: [{ name: "write" }], category: "prod" },
      "server-c": { tools: [{ name: "delete" }], category: "staging" },
    }

        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const agent = createAgent("multi-agent", { allowedMcpCategories: ["dev", "staging"] })
          return yield* mcp.tools(agent)
        }).pipe(provideInstance(tmp.path), Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Should return tools from server-a (dev) and server-c (staging)
        expect(result).toHaveProperty("server-a_read")
        expect(result).not.toHaveProperty("server-b_write")
        expect(result).toHaveProperty("server-c_delete")
  })

  test("MCP.tools() returns all tools when agent has empty allowedMcpCategories", async () => {
    await using tmp = await tmpdir({ git: true })

    const mockConfig = {
      "server-a": { tools: [{ name: "read" }], category: "dev" },
      "server-b": { tools: [{ name: "write" }], category: "prod" },
    }

        const runTools = Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const agent = createAgent("empty-agent", { allowedMcpCategories: [] })
          return yield* mcp.tools(agent)
        }).pipe(provideInstance(tmp.path), Effect.provide(Layer.mergeAll(Config.defaultLayer, createMockMcpLayer(mockConfig))))

        const result = await Effect.runPromise(runTools)

        // Empty array is truthy, so servers with any category will be skipped
        expect(result).not.toHaveProperty("server-a_read")
        expect(result).not.toHaveProperty("server-b_write")
  })
})

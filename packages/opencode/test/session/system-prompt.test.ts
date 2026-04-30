/**
 * Tests for Session ID in System Prompt feature (01-session-id-system-prompt.md)
 *
 * These tests verify that:
 * 1. The environment() method accepts optional sessionID and parentSessionID parameters
 * 2. Session ID appears in the <env> block when provided
 * 3. Parent Session ID appears in the <env> block when provided
 * 4. Backward compatibility - no session ID lines when parameters are omitted
 * 5. The rest of the <env> block is unchanged
 */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SystemPrompt } from "../../src/session/system"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { ModelID, ProviderID } from "../../src/provider/schema"

describe("session.system-prompt", () => {
  test("environment includes Session ID when provided", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    const runEnv = Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(
        {
          id: ModelID.make("claude-sonnet-4-20250514"),
          providerID: ProviderID.anthropic,
          api: { id: "claude-sonnet-4-20250514", url: "", npm: "@anthropic/sdk" },
          name: "Claude Sonnet 4",
          family: undefined,
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 0, input: 0, output: 0 },
          status: "active" as const,
          options: {},
          headers: {},
          release_date: "",
          variants: undefined,
        },
        "ses_241c208c9ffeI6DgeZh6Qhu3sl",
        undefined,
      )
      return result
    }).pipe(provideInstance(tmp.path), Effect.provide(SystemPrompt.defaultLayer))

    const result = await Effect.runPromise(runEnv)
    const envBlock = result[0]

    expect(envBlock).toContain("Session ID: ses_241c208c9ffeI6DgeZh6Qhu3sl")
    expect(envBlock).not.toContain("Parent Session ID:")
  })

  test("environment includes Parent Session ID when provided", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    const runEnv = Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(
        {
          id: ModelID.make("claude-sonnet-4-20250514"),
          providerID: ProviderID.anthropic,
          api: { id: "claude-sonnet-4-20250514", url: "", npm: "@anthropic/sdk" },
          name: "Claude Sonnet 4",
          family: undefined,
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 0, input: 0, output: 0 },
          status: "active" as const,
          options: {},
          headers: {},
          release_date: "",
          variants: undefined,
        },
        undefined,
        "ses_parent123",
      )
      return result
    }).pipe(provideInstance(tmp.path), Effect.provide(SystemPrompt.defaultLayer))

    const result = await Effect.runPromise(runEnv)
    const envBlock = result[0]

    expect(envBlock).toContain("Parent Session ID: ses_parent123")
    expect(envBlock).not.toMatch(/^[ ]*Session ID:.*$/m)
  })

  test("environment includes both Session ID and Parent Session ID when both provided", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    const runEnv = Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(
        {
          id: ModelID.make("claude-sonnet-4-20250514"),
          providerID: ProviderID.anthropic,
          api: { id: "claude-sonnet-4-20250514", url: "", npm: "@anthropic/sdk" },
          name: "Claude Sonnet 4",
          family: undefined,
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 0, input: 0, output: 0 },
          status: "active" as const,
          options: {},
          headers: {},
          release_date: "",
          variants: undefined,
        },
        "ses_child123",
        "ses_parent456",
      )
      return result
    }).pipe(provideInstance(tmp.path), Effect.provide(SystemPrompt.defaultLayer))

    const result = await Effect.runPromise(runEnv)
    const envBlock = result[0]

    expect(envBlock).toContain("Session ID: ses_child123")
    expect(envBlock).toContain("Parent Session ID: ses_parent456")
  })

  test("environment is backward compatible without session parameters", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    const runEnv = Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(
        {
          id: ModelID.make("claude-sonnet-4-20250514"),
          providerID: ProviderID.anthropic,
          api: { id: "claude-sonnet-4-20250514", url: "", npm: "@anthropic/sdk" },
          name: "Claude Sonnet 4",
          family: undefined,
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 0, input: 0, output: 0 },
          status: "active" as const,
          options: {},
          headers: {},
          release_date: "",
          variants: undefined,
        },
      )
      return result
    }).pipe(provideInstance(tmp.path), Effect.provide(SystemPrompt.defaultLayer))

    const result = await Effect.runPromise(runEnv)
    const envBlock = result[0]

    expect(envBlock).toContain("<env>")
    expect(envBlock).toContain("</env>")
    expect(envBlock).toContain("Working directory:")
    expect(envBlock).toContain("Workspace root folder:")
    expect(envBlock).toContain("Is directory a git repo:")
    expect(envBlock).toContain("Platform:")
    expect(envBlock).toContain("Today's date:")

    expect(envBlock).not.toContain("Session ID:")
    expect(envBlock).not.toContain("Parent Session ID:")
  })

  test("environment maintains correct field order", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    const runEnv = Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(
        {
          id: ModelID.make("claude-sonnet-4-20250514"),
          providerID: ProviderID.anthropic,
          api: { id: "claude-sonnet-4-20250514", url: "", npm: "@anthropic/sdk" },
          name: "Claude Sonnet 4",
          family: undefined,
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 0, input: 0, output: 0 },
          status: "active" as const,
          options: {},
          headers: {},
          release_date: "",
          variants: undefined,
        },
        "ses_child",
        "ses_parent",
      )
      return result
    }).pipe(provideInstance(tmp.path), Effect.provide(SystemPrompt.defaultLayer))

    const result = await Effect.runPromise(runEnv)
    const envBlock = result[0]
    const lines = envBlock.split("\n")

    const envStartIndex = lines.findIndex(line => line === "<env>")
    expect(envStartIndex).toBeGreaterThanOrEqual(0)

    expect(lines[envStartIndex]).toBe("<env>")
    expect(lines[envStartIndex + 1]).toContain("Working directory:")
    expect(lines[envStartIndex + 2]).toContain("Workspace root folder:")
    expect(lines[envStartIndex + 3]).toContain("Is directory a git repo:")
    expect(lines[envStartIndex + 4]).toContain("Platform:")
    expect(lines[envStartIndex + 5]).toContain("Today's date:")
    expect(lines[envStartIndex + 6]).toContain("Session ID: ses_child")
    expect(lines[envStartIndex + 7]).toContain("Parent Session ID: ses_parent")
    expect(lines[envStartIndex + 8]).toBe("</env>")
  })

  test("environment includes model information in first line", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    const runEnv = Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(
        {
          id: ModelID.make("claude-sonnet-4-20250514"),
          providerID: ProviderID.anthropic,
          api: { id: "claude-sonnet-4-20250514", url: "", npm: "@anthropic/sdk" },
          name: "Claude Sonnet 4",
          family: undefined,
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 0, input: 0, output: 0 },
          status: "active" as const,
          options: {},
          headers: {},
          release_date: "",
          variants: undefined,
        },
      )
      return result
    }).pipe(provideInstance(tmp.path), Effect.provide(SystemPrompt.defaultLayer))

    const result = await Effect.runPromise(runEnv)
    const firstLine = result[0].split("\n")[0]

    expect(firstLine).toContain("claude-sonnet-4-20250514")
    expect(firstLine).toContain("anthropic/claude-sonnet-4-20250514")
  })

  test("interface accepts optional parameters without throwing", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    const runEnv = Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service

      const makeModel = () => ({
        id: ModelID.make("test"),
        providerID: ProviderID.make("test"),
        api: { id: "test", url: "", npm: "test" },
        name: "Test",
        family: undefined,
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 0, input: 0, output: 0 },
        status: "active" as const,
        options: {},
        headers: {},
        release_date: "",
        variants: undefined,
      })

      yield* svc.environment(makeModel())
      yield* svc.environment(makeModel(), "ses_test")
      yield* svc.environment(makeModel(), undefined, "ses_parent")
      yield* svc.environment(makeModel(), "ses_child", "ses_parent")
    }).pipe(provideInstance(tmp.path), Effect.provide(SystemPrompt.defaultLayer))

    await Effect.runPromise(runEnv)
  })
})

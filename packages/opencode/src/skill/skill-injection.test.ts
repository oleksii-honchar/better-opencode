import path from "path"
import { describe, test, expect, beforeEach } from "bun:test"
import { Effect, Layer, Context } from "effect"
import * as fs from "fs"
import * as os from "os"
import { MessageV2 } from "@/session/message-v2"
import * as Skill from "@/skill"
import * as SystemPrompt from "@/session/system"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { LLMRequestPrep } from "@/session/llm/request"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"

// Mock skill with known content for testing
const TEST_SKILL = {
  name: "test-skill",
  description: "A test skill for verifying skill injection",
  location: "/tmp/test-skill/SKILL.md",
  content: "# Test Skill\n\nThis is the full content of the test skill.",
}

// Helper to create a mock agent
function createMockAgent(): Agent.Info {
  return {
    name: "test-agent",
    prompt: "You are a test agent.",
    mode: "all",
    temperature: 0.7,
    topP: 1.0,
    permission: [],
    options: {},
    smartModels: [],
  }
}

// Helper to create a mock provider
function createMockProvider(): Provider.Info {
  return {
    id: ProviderID.make("test-provider"),
    name: "Test Provider",
    source: "custom",
    env: [],
    key: "test-key",
    options: {},
    models: {},
  }
}

// Helper to create a mock user message
function createMockUserMessage(sessionID: string): MessageV2.User {
  return {
    id: MessageID.ascending(),
    sessionID: SessionID.make(sessionID),
    role: "user",
    time: { created: Date.now() },
    agent: "test-agent",
    model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
  }
}

// Mock Skill.Service layer for testing
function createMockSkillLayer(): Layer.Layer<Skill.Service, never, never> {
  const state: {
    skills: Record<string, Skill.Info>
    dynamicSkills: Record<string, Skill.Info>
    dirs: Set<string>
    promoted: boolean
  } = {
    skills: { "test-skill": TEST_SKILL },
    dynamicSkills: {},
    dirs: new Set(),
    promoted: false,
  }

  const get = Effect.fn("MockSkill.get")(function* (name: string) {
    return state.skills[name]
  })
  const require = Effect.fn("MockSkill.require")(function* (name: string) {
    const info = state.skills[name]
    if (info) return info
    return yield* new Skill.NotFoundError({ name, available: Object.keys(state.skills).toSorted() })
  })
  const all = Effect.fn("MockSkill.all")(function* () {
    return Object.values(state.skills)
  })
  const allIncludingDynamic = Effect.fn("MockSkill.allIncludingDynamic")(function* () {
    return [...Object.values(state.skills), ...Object.values(state.dynamicSkills)]
  })
  const dirs = Effect.fn("MockSkill.dirs")(function* () {
    return Array.from(state.dirs)
  })
  const available = Effect.fn("MockSkill.available")(function* (agent?: Agent.Info) {
    return Object.values(state.skills).toSorted((a, b) => a.name.localeCompare(b.name))
  })
  const registerDynamic = Effect.fn("MockSkill.registerDynamic")(function* (newSkills: Skill.Info[]) {
    let added = 0
    let skipped = 0
    for (const skill of newSkills) {
      if (state.skills[skill.name] || state.dynamicSkills[skill.name]) {
        skipped++
      } else {
        state.dynamicSkills[skill.name] = skill
        added++
      }
    }
    return { added, skipped }
  })
  const promoteDynamicToStartup = Effect.fn("MockSkill.promoteDynamicToStartup")(function* () {
    const count = Object.keys(state.dynamicSkills).length
    for (const [name, info] of Object.entries(state.dynamicSkills)) {
      state.skills[name] = info
    }
    state.dynamicSkills = {}
    state.promoted = true
    return { promoted: count }
  })

  const skillService = { get, require, all, allIncludingDynamic, dirs, available, registerDynamic, promoteDynamicToStartup }

  return Layer.succeed(Skill.Service, skillService)
}

// Mock SystemPrompt.Service layer for testing
function createMockSystemPromptLayer(): Layer.Layer<SystemPrompt.Service, never, never> {
  const skills = Effect.fn("MockSystemPrompt.skills")(function* (agent: Agent.Info) {
    // Return skill metadata formatted like SystemPrompt.skills()
    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      "<available_skills>",
      "  <skill>",
      "    <name>test-skill</name>",
      "    <description>A test skill for verifying skill injection</description>",
      "    <location>file:///tmp/test-skill/SKILL.md</location>",
      "  </skill>",
      "</available_skills>",
    ].join("\n")
  })

  const environment = Effect.fn("MockSystemPrompt.environment")(function* () {
    return ["Environment info"]
  })

  const sysService = { skills, environment }

  return Layer.succeed(SystemPrompt.Service, sysService)
}

describe("LLMRequestPrep skill injection for new chats", () => {
  test("new chat includes skill content in system prompt", async () => {
    const agent = createMockAgent()
    const provider = createMockProvider()
    const user = createMockUserMessage("ses-test-new")
    const model = {
      providerID: "test-provider",
      id: "test-provider/gpt-4",
      api: { id: "gpt-4", name: "GPT-4", cost: 0 },
      capabilities: { temperature: true },
      options: {},
      headers: {},
      limit: { output: 4096 },
    } as any

    const tools: Record<string, any> = {}

    // Simulate what llm.ts does for new chats: fetch skill content and pass it to prepare
    const skillContent =
      "Skills provide specialized instructions and workflows for specific tasks.\n" +
      "Use the skill tool to load a skill when a task matches its description.\n" +
      "<available_skills>\n" +
      "  <skill>\n" +
      "    <name>test-skill</name>\n" +
      "    <description>A test skill for verifying skill injection</description>\n" +
      "    <location>file:///tmp/test-skill/SKILL.md</location>\n" +
      "  </skill>\n" +
      "</available_skills>"

    // Empty messages array = new chat
    const program = LLMRequestPrep.prepare({
      user,
      sessionID: "ses-test-new",
      model,
      agent,
      permission: [],
      system: [],
      messages: [], // Empty = new chat
      small: false,
      tools,
      provider,
      auth: undefined,
      plugin: {
        trigger: (hook: string, ctx: any, input: any) => Effect.succeed(input),
      } as any,
      flags: { client: "test", outputTokenMax: 4096, disableExternalSkills: true } as any,
      isWorkflow: false,
      skillContent,
    })

    const result = await Effect.runPromise(program)

    // For new chat, skill content should be in the system prompt
    const systemText = result.system.join("\n")
    expect(systemText).toContain("test-skill")
    expect(systemText).toContain("Skills provide specialized instructions")
  })

  test("ongoing chat does not inject skill content via prepare", async () => {
    const agent = createMockAgent()
    const provider = createMockProvider()
    const user = createMockUserMessage("ses-test-ongoing")
    const model = {
      providerID: "test-provider",
      id: "test-provider/gpt-4",
      api: { id: "gpt-4", name: "GPT-4", cost: 0 },
      capabilities: { temperature: true },
      options: {},
      headers: {},
      limit: { output: 4096 },
    } as any

    const tools: Record<string, any> = {}

    // Non-empty messages array = ongoing chat
    const priorMessages = [
      { role: "user" as const, content: "Previous message" },
      { role: "assistant" as const, content: "Previous response" },
    ]

    // For ongoing chats, skill content is NOT passed (handled by scanParts/injection)
    const program = LLMRequestPrep.prepare({
      user,
      sessionID: "ses-test-ongoing",
      model,
      agent,
      permission: [],
      system: [],
      messages: priorMessages, // Non-empty = ongoing chat
      small: false,
      tools,
      provider,
      auth: undefined,
      plugin: {
        trigger: (hook: string, ctx: any, input: any) => Effect.succeed(input),
      } as any,
      flags: { client: "test", outputTokenMax: 4096, disableExternalSkills: true } as any,
      isWorkflow: false,
      // skillContent not passed for ongoing chats
    })

    const result = await Effect.runPromise(program)

    // For ongoing chat, skill content should NOT be in the system prompt
    // (it's handled by scanParts/injection mechanism)
    const systemText = result.system.join("\n")
    expect(systemText).not.toContain("Skills provide specialized instructions")
    expect(systemText).not.toContain("test-skill")
  })
})

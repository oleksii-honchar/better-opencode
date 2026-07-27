import path from "path"
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { Effect, Layer, Context, Fiber, Option } from "effect"
import * as fs from "fs"
import * as os from "os"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { MessageV2 } from "@/session/message-v2"
import * as Skill from "@/skill"
import * as SessionMetadata from "@/skill/session-metadata"
import { PartID, SessionID, MessageID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { Session } from "@/session/session"
import type { Session as SessionModule } from "@/session/session"

// Minimal mock layer: provides Skill.Service with controlled state
// Bypasses InstanceState complexity by directly providing the interface
function createMockService(): Skill.Interface {
  const state: {
    skills: Record<string, Skill.Info>
    dynamicSkills: Record<string, Skill.Info>
    dirs: Set<string>
    promoted: boolean
  } = {
    skills: {},
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
  const dirs = Effect.fn("MockSkill.dirs")(function* () {
    return Array.from(state.dirs)
  })
  const available = Effect.fn("MockSkill.available")(function* () {
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
    if (state.promoted) {
      return { promoted: 0 }
    }
    const count = Object.keys(state.dynamicSkills).length
    for (const [name, info] of Object.entries(state.dynamicSkills)) {
      state.skills[name] = info
    }
    state.dynamicSkills = {}
    state.promoted = true
    return { promoted: count }
  })

  return { get, require, all, dirs, available, registerDynamic, promoteDynamicToStartup }
}

function mockSkillLayer(): Layer.Layer<Skill.Service> {
  return Layer.succeed(Skill.Service, createMockService())
}

// Minimal mock Session.Service for flushInjectedMessages
function createMockSessionService(): SessionModule.Interface {
  return {
    list: () => Effect.succeed([]),
    create: () => Effect.succeed({} as any),
    fork: () => Effect.succeed({} as any),
    touch: () => Effect.void,
    get: () => Effect.succeed({} as any),
    setTitle: () => Effect.void,
    setArchived: () => Effect.void,
    setPermission: () => Effect.void,
    setRevert: () => Effect.void,
    clearRevert: () => Effect.void,
    setSummary: () => Effect.void,
    diff: () => Effect.succeed([]),
    messages: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    remove: () => Effect.void,
    updateMessage: (msg) => Effect.succeed(msg),
    removeMessage: () => Effect.succeed(MessageID.make("mock")),
    removePart: () => Effect.succeed(PartID.make("mock")),
    getPart: () => Effect.succeed(undefined),
    updatePart: (part) => Effect.succeed(part),
    updatePartDelta: () => Effect.void,
    findMessage: () => Effect.succeed(Option.none()),
  }
}

function mockSessionLayer(): Layer.Layer<Session.Service> {
  return Layer.succeed(Session.Service, createMockSessionService())
}

// We test the scanParts function that will be added to dynamic-scanner
// Import is deferred until after implementation exists
let DynamicSkillScanner: typeof import("@/skill/dynamic-scanner")

describe("DynamicSkillScanner.scanParts", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-parts-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function loadModule() {
    if (!DynamicSkillScanner) {
      DynamicSkillScanner = await import("@/skill/dynamic-scanner")
    }
  }

  function run<T>(program: Effect.Effect<T, unknown, AppFileSystem.Service | Skill.Service | SessionMetadata.SessionMetadataService | Session.Service>) {
    return Effect.runPromise(
      Effect.provide(
        Effect.provide(
          Effect.provide(
            Effect.provide(program, AppFileSystem.defaultLayer),
            mockSkillLayer(),
          ),
          SessionMetadata.defaultLayer,
        ),
        mockSessionLayer(),
      ),
    )
  }

  const dummyAgent = "test-agent"
  const dummyProviderID = ProviderID.make("test-provider")
  const dummyModelID = ModelID.make("test-model")

  // Helper: create a valid SKILL.md file
  function createSkill(skillDir: string, name: string, description?: string) {
    const dir = path.join(skillDir, name)
    fs.mkdirSync(dir, { recursive: true })
    const frontmatter = `---\nname: ${name}\n${description ? `description: ${description}\n` : ""}---\n\n# ${name}\n\nSkill content for ${name}`
    fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter)
    return path.join(dir, "SKILL.md")
  }

  // Helper: create a test repo with .agents/skills
  function createTestRepo(repoName: string, skillName?: string) {
    const repoDir = path.join(tmpDir, repoName)
    const agentsDir = path.join(repoDir, ".agents")
    fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
    if (skillName) {
      createSkill(path.join(agentsDir, "skills"), skillName, `Skill for ${repoName}`)
    }
    return { repoDir, agentsDir }
  }

  describe("path extraction from text parts", () => {
    test("extracts absolute Unix paths from text", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("unix-repo", "unix-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Check this file: ${filePath}`,
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.scannedPaths).toContainEqual(
        expect.stringContaining("unix-repo"),
      )
    })

    test("extracts absolute Windows-style paths from text", async () => {
      await loadModule()
      // Simulate Windows-style path in text (C:\...)
      // In real usage, text from user/model contains literal backslashes
      const winStylePath = "C:\\\\Users\\\\test\\\\file.ts"
      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Check this file: ${winStylePath}`,
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      // Windows paths are extracted even if not real on this platform
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
    })

    test("extracts multiple paths from single text part", async () => {
      await loadModule()
      const { repoDir: repo1 } = createTestRepo("multi-repo-1", "multi-skill-1")
      const { repoDir: repo2 } = createTestRepo("multi-repo-2", "multi-skill-2")
      const file1 = path.join(repo1, "file1.ts")
      const file2 = path.join(repo2, "file2.ts")
      fs.writeFileSync(file1, "content")
      fs.writeFileSync(file2, "content")

      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Check these files: ${file1} and ${file2}`,
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(2)
    })

    test("ignores relative paths in text", async () => {
      await loadModule()
      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Check src/file.ts and ./other.js`,
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBe(0)
    })

    test("extracts paths from synthetic Read tool references", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("read-ref-repo", "read-ref-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Called the Read tool with the following input: {"filePath":"${filePath}"}`,
          synthetic: true,
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
    })

    test("extracts paths from synthetic Read tool references with JSON string", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("json-ref-repo", "json-ref-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Called the Read tool with the following input: {"filePath":"${filePath}"}`,
          synthetic: true,
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
    })
  })

  describe("path extraction from file parts", () => {
    test("extracts path from file part with source.path", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("file-source-repo", "file-source-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const parts: MessageV2.Part[] = [
        {
          type: "file",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          url: `file://${filePath}`,
          mime: "text/plain",
          filename: "file.ts",
          source: {
            type: "file" as const,
            path: filePath,
            text: { value: "content", start: 0, end: 7 },
          },
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
    })

    test("extracts path from file part with symbol source", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("symbol-source-repo", "symbol-source-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const parts: MessageV2.Part[] = [
        {
          type: "file",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          url: `file://${filePath}`,
          mime: "text/plain",
          filename: "file.ts",
          source: {
            type: "symbol" as const,
            path: filePath,
            name: "myFunction",
            kind: 12,
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
            text: { value: "content", start: 0, end: 7 },
          },
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
    })

    test("extracts path from file attachment filename when it is absolute", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("attachment-repo", "attachment-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const parts: MessageV2.Part[] = [
        {
          type: "file",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          url: `data:text/plain;base64,${Buffer.from("content").toString("base64")}`,
          mime: "text/plain",
          filename: filePath,
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
    })
  })

  describe("deduplication", () => {
    test("deduplicates identical paths by realpath", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("dedup-repo", "dedup-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      // Same path mentioned multiple times
      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Check ${filePath} again ${filePath} and once more ${filePath}`,
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      // Should only scan the unique path once
      expect(result.scannedPaths.length).toBe(1)
    })

    test("deduplicates paths from different sources pointing to same file", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("cross-dedup-repo", "cross-dedup-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      // Same path in text and file part
      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Check this file: ${filePath}`,
        },
        {
          type: "file",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          url: `file://${filePath}`,
          mime: "text/plain",
          filename: "file.ts",
          source: {
            type: "file" as const,
            path: filePath,
            text: { value: "content", start: 0, end: 7 },
          },
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      // Should only scan the unique path once
      expect(result.scannedPaths.length).toBe(1)
    })
  })

  describe("skill registration", () => {
    test("registers discovered skills via Skill.Service.registerDynamic", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("register-repo", "registered-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Check this file: ${filePath}`,
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      // Skills should be discovered and registered
      expect(result.skillsRegistered).toBeGreaterThanOrEqual(1)
      expect(result.skillNames).toContain("registered-skill")
    })
  })

  describe("error handling", () => {
    test("handles non-existent paths gracefully", async () => {
      await loadModule()
      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Check this file: /nonexistent/path/to/file.ts`,
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      // Should not throw, paths found but no skills
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBe(0)
    })

    test("handles empty parts array", async () => {
      await loadModule()
      const parts: MessageV2.Part[] = []

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBe(0)
      expect(result.scannedPaths).toEqual([])
    })

    test("handles parts with no extractable paths", async () => {
      await loadModule()
      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: "Hello world, no paths here!",
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBe(0)
      expect(result.scannedPaths).toEqual([])
    })

    test("ignores non-text/non-file part types", async () => {
      await loadModule()
      const parts: MessageV2.Part[] = [
        {
          type: "reasoning",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: "/some/path/here",
          time: { start: 0, end: 100 },
        },
      ]

      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBe(0)
    })
  })

  describe("logging", () => {
    test("logs trigger-prompt event with partType and pathCount", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("log-repo", "log-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: `Check this file: ${filePath}`,
        },
      ]

      // Just verify it runs without error — logging is internal
      const result = await run(DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
    })
  })

  describe("non-blocking behavior", () => {
    test("scanParts can be forked without blocking", async () => {
      await loadModule()
      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-test"),
          messageID: MessageID.make("msg-1"),
          text: "Hello world",
        },
      ]

      const program = Effect.gen(function* () {
        const fiber = yield* DynamicSkillScanner.scanParts(parts, SessionID.make("ses-test"), dummyAgent, dummyProviderID, dummyModelID).pipe(
          Effect.forkChild,
        )
        return yield* Fiber.join(fiber)
      })

      const result = await run(program)
      expect(result).toBeDefined()
      expect(result.pathsFound).toBe(0)
    })
  })

  describe("self-injection", () => {
    test("scanParts calls injectDiscoveredSkills and flushInjectedMessages after registration", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("inject-repo", "inject-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-inject-test"),
          messageID: MessageID.make("msg-1"),
          text: `Check this file: ${filePath}`,
        },
      ]

      const sessionID = SessionID.make("ses-inject-test")
      const agent = "test-agent"
      const providerID = ProviderID.make("test-provider")
      const modelID = ModelID.make("test-model")

      // Spy on injectDiscoveredSkills and flushInjectedMessages
      const injectSpy = spyOn(DynamicSkillScanner, "injectDiscoveredSkills")
      const flushSpy = spyOn(DynamicSkillScanner, "flushInjectedMessages")
      let flushInput: unknown

      // Override flush spy to capture input and return Effect<void>
      flushSpy.mockImplementation((input: unknown) => {
        flushInput = input
        return Effect.void
      })

      const program = Effect.gen(function* () {
        return yield* DynamicSkillScanner.scanParts(parts, sessionID, agent, providerID, modelID)
      })

      const result = await run(program)

      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBeGreaterThanOrEqual(1)
      expect(injectSpy).toHaveBeenCalled()
      expect(flushSpy).toHaveBeenCalled()
      expect(flushInput).toMatchObject({
        sessionID,
        agent,
        providerID,
        modelID,
      })

      injectSpy.mockRestore()
      flushSpy.mockRestore()
    })

    test("scanParts does not call flushInjectedMessages when no skills injected", async () => {
      await loadModule()
      const parts: MessageV2.Part[] = [
        {
          type: "text",
          id: PartID.ascending(),
          sessionID: SessionID.make("ses-no-inject"),
          messageID: MessageID.make("msg-1"),
          text: "No paths here",
        },
      ]

      const sessionID = SessionID.make("ses-no-inject")
      const agent = "test-agent"
      const providerID = ProviderID.make("test-provider")
      const modelID = ModelID.make("test-model")

      const flushSpy = spyOn(DynamicSkillScanner, "flushInjectedMessages")
      flushSpy.mockImplementation(() => Effect.void)

      const program = Effect.gen(function* () {
        return yield* DynamicSkillScanner.scanParts(parts, sessionID, agent, providerID, modelID)
      })

      const result = await run(program)

      expect(result.pathsFound).toBe(0)
      expect(result.skillsRegistered).toBe(0)
      expect(flushSpy).not.toHaveBeenCalled()

      flushSpy.mockRestore()
    })
  })
})

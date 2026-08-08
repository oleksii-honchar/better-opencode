import path from "path"
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Layer, Fiber, Stream } from "effect"
import * as fs from "fs"
import * as os from "os"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Skill from "@/skill"
import * as SessionMetadata from "@/skill/session-metadata"
import { PartID, SessionID, MessageID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { Session } from "@/session/session"
import type { Session as SessionModule } from "@/session/session"
import { Ripgrep } from "@/file/ripgrep"

// ---------------------------------------------------------------------------
// Mock Skill.Service layer (same pattern as scan-parts.test.ts)
// ---------------------------------------------------------------------------

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
  const allIncludingDynamic = Effect.fn("MockSkill.allIncludingDynamic")(function* () {
    return [...Object.values(state.skills), ...Object.values(state.dynamicSkills)]
  })

  return { get, require, all, dirs, available, allIncludingDynamic, registerDynamic, promoteDynamicToStartup }
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
    findMessage: () => Effect.succeed(undefined as any),
  }
}

function mockSessionLayer(): Layer.Layer<Session.Service> {
  return Layer.succeed(Session.Service, createMockSessionService())
}

// Minimal mock Ripgrep.Service for file scanning
function createMockRipgrepService(): Ripgrep.Interface {
  return {
    files: () => Stream.empty,
    tree: () => Effect.succeed(""),
    search: () => Effect.succeed({ items: [], partial: false }),
  }
}

function mockRipgrepLayer(): Layer.Layer<Ripgrep.Service> {
  return Layer.succeed(Ripgrep.Service, createMockRipgrepService())
}

// Deferred import — loaded after implementation exists
let DynamicSkillScanner: typeof import("@/skill/dynamic-scanner")

describe("DynamicSkillScanner.scanToolArgs", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-tool-args-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function loadModule() {
    if (!DynamicSkillScanner) {
      DynamicSkillScanner = await import("@/skill/dynamic-scanner")
    }
  }

  function run<T>(program: Effect.Effect<T, unknown, AppFileSystem.Service | Skill.Service | SessionMetadata.SessionMetadataService | Session.Service | Ripgrep.Service>) {
    return Effect.runPromise(
      Effect.provide(
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
        mockRipgrepLayer(),
      ),
    )
  }

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

  const dummyAgent = "test-agent"
  const dummyProviderID = ProviderID.make("test-provider")
  const dummyModelID = ModelID.make("test-model")
  const dummySessionID = SessionID.make("ses-test")

  describe("path extraction from tool args", () => {
    test("extracts filePath from read tool args", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("read-repo", "read-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const args = { filePath }
      const result = await run(DynamicSkillScanner.scanToolArgs("read", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBeGreaterThanOrEqual(1)
    })

    test("extracts filePath from write tool args", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("write-repo", "write-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const args = { filePath, content: "new content" }
      const result = await run(DynamicSkillScanner.scanToolArgs("write", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBeGreaterThanOrEqual(1)
    })

    test("extracts filePath from edit tool args", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("edit-repo", "edit-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const args = { filePath, oldString: "old", newString: "new" }
      const result = await run(DynamicSkillScanner.scanToolArgs("edit", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBeGreaterThanOrEqual(1)
    })

    test("extracts directory from glob pattern", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("glob-repo", "glob-skill")
      const pattern = path.join(repoDir, "src", "**/*.ts")

      const args = { pattern }
      const result = await run(DynamicSkillScanner.scanToolArgs("glob", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBeGreaterThanOrEqual(1)
    })

    test("extracts path from grep tool args", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("grep-repo", "grep-skill")
      // grep path is typically a directory; scanner walks up from it
      // Use a subdirectory so .agents/ is found by walking up
      const subDir = path.join(repoDir, "src")
      fs.mkdirSync(subDir, { recursive: true })

      const args = { path: subDir, pattern: "some-pattern" }
      const result = await run(DynamicSkillScanner.scanToolArgs("grep", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBeGreaterThanOrEqual(1)
    })

    test("extracts paths from apply_patch +++ b/ lines", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("patch-repo", "patch-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const patch = `--- a/src/file.ts
+++ b/src/file.ts
@@ -1 +1 @@
-old
+new
`
      // Patch uses relative paths; we resolve them relative to repoDir
      const args = { patch }
      const result = await run(DynamicSkillScanner.scanToolArgs("apply_patch", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      // Should extract path from +++ b/ line
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
    })

    test("extracts multiple paths from apply_patch with multiple files", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("multi-patch-repo", "multi-patch-skill")
      fs.mkdirSync(path.join(repoDir, "src"), { recursive: true })

      const patch = `--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1 +1 @@
-old1
+new1
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1 +1 @@
-old2
+new2
`
      const args = { patch }
      const result = await run(DynamicSkillScanner.scanToolArgs("apply_patch", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(2)
    })
  })

  describe("unknown tool handling", () => {
    test("handles unknown tool gracefully as no-op", async () => {
      await loadModule()
      const args = { someArg: "value" }
      const result = await run(DynamicSkillScanner.scanToolArgs("unknown-tool", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBe(0)
      expect(result.skillsRegistered).toBe(0)
    })

    test("handles MCP tool with no known path fields gracefully", async () => {
      await loadModule()
      const args = { server: "some-mcp", command: "do-something" }
      const result = await run(DynamicSkillScanner.scanToolArgs("some-mcp-server__someTool", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBe(0)
      expect(result.skillsRegistered).toBe(0)
    })

    test("handles empty args gracefully", async () => {
      await loadModule()
      const result = await run(DynamicSkillScanner.scanToolArgs("read", {}, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBe(0)
      expect(result.skillsRegistered).toBe(0)
    })
  })

  describe("skill registration", () => {
    test("registers discovered skills via Skill.Service.registerDynamic", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("register-tool-repo", "tool-registered-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const args = { filePath }
      const result = await run(DynamicSkillScanner.scanToolArgs("read", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBeGreaterThanOrEqual(1)
      expect(result.skillNames).toContain("tool-registered-skill")
    })
  })

  describe("error handling", () => {
    test("handles non-existent filePath gracefully", async () => {
      await loadModule()
      const args = { filePath: "/nonexistent/path/to/file.ts" }
      const result = await run(DynamicSkillScanner.scanToolArgs("read", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBe(0)
    })

    test("handles invalid patch format gracefully", async () => {
      await loadModule()
      const args = { patch: "not a valid patch at all" }
      const result = await run(DynamicSkillScanner.scanToolArgs("apply_patch", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBe(0)
      expect(result.skillsRegistered).toBe(0)
    })

    test("handles malformed args gracefully", async () => {
      await loadModule()
      const args = { filePath: 12345 } // wrong type
      const result = await run(DynamicSkillScanner.scanToolArgs("read", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID))
      expect(result.pathsFound).toBe(0)
      expect(result.skillsRegistered).toBe(0)
    })
  })

  describe("non-blocking behavior", () => {
    test("scanToolArgs can be forked without blocking", async () => {
      await loadModule()
      const args = { filePath: "/some/path.ts" }

      const program = Effect.gen(function* () {
        const fiber = yield* DynamicSkillScanner.scanToolArgs("read", args, dummySessionID, dummyAgent, dummyProviderID, dummyModelID).pipe(
          Effect.forkChild,
        )
        return yield* Fiber.join(fiber)
      })

      const result = await run(program)
      expect(result).toBeDefined()
    })
  })
})

describe("DynamicSkillScanner.injectDiscoveredSkills", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inject-skills-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function loadModule() {
    if (!DynamicSkillScanner) {
      DynamicSkillScanner = await import("@/skill/dynamic-scanner")
    }
  }

  function run<T>(program: Effect.Effect<T, unknown, Skill.Service | SessionMetadata.SessionMetadataService | Ripgrep.Service>) {
    return Effect.runPromise(
      Effect.provide(
        Effect.provide(
          Effect.provide(program, mockSkillLayer()),
          SessionMetadata.defaultLayer,
        ),
        mockRipgrepLayer(),
      ),
    )
  }

  describe("synthetic message formatting", () => {
    test("formats skills as <available_skills> XML with full content injection", async () => {
      await loadModule()

      // Create real skill directories so ripgrep can scan files
      const skill1Dir = path.join(tmpDir, "test-skill-1")
      const skill2Dir = path.join(tmpDir, "test-skill-2")
      fs.mkdirSync(skill1Dir, { recursive: true })
      fs.mkdirSync(skill2Dir, { recursive: true })
      fs.writeFileSync(path.join(skill1Dir, "SKILL.md"), "---\nname: test-skill-1\ndescription: First test skill\n---\n\n# Test Skill 1\n\nThis is the full content of skill 1.")
      fs.mkdirSync(path.join(skill1Dir, "scripts"), { recursive: true })
      fs.writeFileSync(path.join(skill1Dir, "scripts", "helper.sh"), "#!/bin/bash\necho hello")
      fs.writeFileSync(path.join(skill2Dir, "SKILL.md"), "---\nname: test-skill-2\ndescription: Second test skill\n---\n\n# Test Skill 2\n\nThis is the full content of skill 2.")
      fs.writeFileSync(path.join(skill2Dir, "reference.md"), "# Reference\n\nSome reference material.")

      const skill1Path = path.join(skill1Dir, "SKILL.md")
      const skill2Path = path.join(skill2Dir, "SKILL.md")

      const mockSvc = createMockService()
      const mockLayer = Layer.succeed(Skill.Service, mockSvc)

      const skills: Skill.Info[] = [
        {
          name: "test-skill-1",
          description: "First test skill",
          location: skill1Path,
          content: "# Test Skill 1\n\nThis is the full content of skill 1.",
        },
        {
          name: "test-skill-2",
          description: "Second test skill",
          location: skill2Path,
          content: "# Test Skill 2\n\nThis is the full content of skill 2.",
        },
      ]

      await Effect.runPromise(
        Effect.provide(mockSvc.registerDynamic(skills), mockLayer),
      )

      for (const skill of skills) {
        await Effect.runPromise(DynamicSkillScanner.trackSkillForInjection(skill))
      }

      const result = await Effect.runPromise(
        Effect.provide(
          Effect.provide(
            DynamicSkillScanner.injectDiscoveredSkills("ses-test"),
            mockLayer,
          ),
          Ripgrep.defaultLayer,
        ),
      )

      expect(result.injected).toBeGreaterThanOrEqual(1)
      expect(result.skillCount).toBeGreaterThanOrEqual(1)
      expect(result.xml).toBeDefined()

      const xml = result.xml!

      // Verify <skill_content> wrapper with full content for each skill
      expect(xml).toContain('<skill_content name="test-skill-1">')
      expect(xml).toContain("# Test Skill 1")
      expect(xml).toContain("This is the full content of skill 1.")
      expect(xml).toContain("</skill_content>")

      expect(xml).toContain('<skill_content name="test-skill-2">')
      expect(xml).toContain("# Test Skill 2")
      expect(xml).toContain("This is the full content of skill 2.")

      // Verify base directory (file:// URL from pathToFileURL)
      expect(xml).toContain(`Base directory for this skill: file://${skill1Dir.replace(/\\/g, "/")}`)
      expect(xml).toContain(`Base directory for this skill: file://${skill2Dir.replace(/\\/g, "/")}`)

      // Verify file list section
      expect(xml).toContain("<skill_files>")
      expect(xml).toContain("</skill_files>")

      // Verify <available_skills> XML is still included
      expect(xml).toContain("<available_skills>")
      expect(xml).toContain("</available_skills>")
    })

    test("returns no injection when no dynamic skills exist", async () => {
      await loadModule()
      const result = await run(DynamicSkillScanner.injectDiscoveredSkills("ses-test"))
      expect(result.injected).toBe(0)
      expect(result.skillCount).toBe(0)
    })

    test("returns no injection when no dynamic skills exist", async () => {
      await loadModule()
      const result = await run(DynamicSkillScanner.injectDiscoveredSkills("ses-test"))
      expect(result.injected).toBe(0)
      expect(result.skillCount).toBe(0)
    })
  })

  describe("deduplication", () => {
    test("injects skills that are in the injection queue", async () => {
      await loadModule()

      // Create mock service
      const mockSvc = createMockService()
      const mockLayer = Layer.succeed(Skill.Service, mockSvc)

      // Register a dynamic skill via the mock service
      const skill: Skill.Info = {
        name: "dynamic-skill",
        description: "A dynamic skill",
        location: "/dynamic/SKILL.md",
        content: "# Dynamic",
      }

      await Effect.runPromise(
        Effect.provide(
          mockSvc.registerDynamic([skill]),
          mockLayer,
        ),
      )

      // Manually add the skill to the injection queue (simulating what scanToolArgs does)
      await Effect.runPromise(DynamicSkillScanner.trackSkillForInjection(skill))

      const result = await Effect.runPromise(
        Effect.provide(
          Effect.provide(
            DynamicSkillScanner.injectDiscoveredSkills("ses-test"),
            mockLayer,
          ),
          mockRipgrepLayer(),
        ),
      )

      // Should inject the dynamic skill
      expect(result.injected).toBeGreaterThanOrEqual(1)
      expect(result.skillCount).toBeGreaterThanOrEqual(1)
    })
  })

  describe("error handling", () => {
    test("catches and logs errors without throwing", async () => {
      await loadModule()
      // Even with a bad sessionID, it should not throw
      const result = await run(DynamicSkillScanner.injectDiscoveredSkills("invalid-session"))
      expect(result).toBeDefined()
    })
  })

  describe("non-blocking behavior", () => {
    test("injectDiscoveredSkills can be forked without blocking", async () => {
      await loadModule()

      const program = Effect.gen(function* () {
        const fiber = yield* DynamicSkillScanner.injectDiscoveredSkills("ses-test").pipe(
          Effect.forkChild,
        )
        return yield* Fiber.join(fiber)
      })

      const result = await run(program)
      expect(result).toBeDefined()
    })
  })
})

describe("DynamicSkillScanner.scanToolArgs self-injection", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-inject-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function loadModule() {
    if (!DynamicSkillScanner) {
      DynamicSkillScanner = await import("@/skill/dynamic-scanner")
    }
  }

  function run<T>(program: Effect.Effect<T, unknown, AppFileSystem.Service | Skill.Service | SessionMetadata.SessionMetadataService | Session.Service | Ripgrep.Service>) {
    return Effect.runPromise(
      Effect.provide(
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
        mockRipgrepLayer(),
      ),
    )
  }

  function createSkill(skillDir: string, name: string, description?: string) {
    const dir = path.join(skillDir, name)
    fs.mkdirSync(dir, { recursive: true })
    const frontmatter = `---\nname: ${name}\n${description ? `description: ${description}\n` : ""}---\n\n# ${name}\n\nSkill content`
    fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter)
  }

  function createTestRepo(repoName: string, skillName?: string) {
    const repoDir = path.join(tmpDir, repoName)
    const agentsDir = path.join(repoDir, ".agents")
    fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
    if (skillName) {
      createSkill(path.join(agentsDir, "skills"), skillName, `Skill for ${repoName}`)
    }
    return { repoDir, agentsDir }
  }

  describe("accepts injection parameters", () => {
    test("scanToolArgs accepts agent, providerID, modelID parameters", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("inject-params-repo", "inject-params-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const args = { filePath }
      const sessionID = SessionID.make("ses-inject-params")
      const agent = "test-agent"
      const providerID = ProviderID.make("test-provider")
      const modelID = ModelID.make("test-model")

      // This test verifies the new signature compiles and runs
      const result = await run(
        DynamicSkillScanner.scanToolArgs("read", args, sessionID, agent, providerID, modelID),
      )

      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBeGreaterThanOrEqual(1)
    })
  })

  describe("calls injectDiscoveredSkills after registration", () => {
    test("scanToolArgs calls injectDiscoveredSkills internally after registering skills", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("inject-call-repo", "inject-call-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const args = { filePath }
      const sessionID = SessionID.make("ses-inject-call")
      const agent = "test-agent"
      const providerID = ProviderID.make("test-provider")
      const modelID = ModelID.make("test-model")

      const result = await run(
        DynamicSkillScanner.scanToolArgs("read", args, sessionID, agent, providerID, modelID),
      )

      // Skills should be registered
      expect(result.pathsFound).toBeGreaterThanOrEqual(1)
      expect(result.skillsRegistered).toBeGreaterThanOrEqual(1)

      // After self-injection, the injection queue should be cleared
      // (injectDiscoveredSkills clears it after formatting)
      // We verify this by calling injectDiscoveredSkills again — should return 0
      const afterInject = await run(DynamicSkillScanner.injectDiscoveredSkills(sessionID))
      expect(afterInject.injected).toBe(0)
      expect(afterInject.skillCount).toBe(0)
    })
  })

  describe("returns same ScanToolArgsResult type", () => {
    test("scanToolArgs returns ScanToolArgsResult with all required fields", async () => {
      await loadModule()
      const { repoDir } = createTestRepo("return-type-repo", "return-type-skill")
      const filePath = path.join(repoDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const args = { filePath }
      const sessionID = SessionID.make("ses-return-type")
      const agent = "test-agent"
      const providerID = ProviderID.make("test-provider")
      const modelID = ModelID.make("test-model")

      const result = await run(
        DynamicSkillScanner.scanToolArgs("read", args, sessionID, agent, providerID, modelID),
      )

      expect(result.pathsFound).toBeDefined()
      expect(result.scannedPaths).toBeDefined()
      expect(result.skillsRegistered).toBeDefined()
      expect(result.skillNames).toBeDefined()
    })
  })
})

describe("DynamicSkillScanner integration: scanToolArgs + injectDiscoveredSkills", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "integration-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function loadModule() {
    if (!DynamicSkillScanner) {
      DynamicSkillScanner = await import("@/skill/dynamic-scanner")
    }
  }

  function createSkill(skillDir: string, name: string, description?: string) {
    const dir = path.join(skillDir, name)
    fs.mkdirSync(dir, { recursive: true })
    const frontmatter = `---\nname: ${name}\n${description ? `description: ${description}\n` : ""}---\n\n# ${name}\n\nSkill content`
    fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter)
  }

  function createTestRepo(repoName: string, skillName?: string) {
    const repoDir = path.join(tmpDir, repoName)
    const agentsDir = path.join(repoDir, ".agents")
    fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
    if (skillName) {
      createSkill(path.join(agentsDir, "skills"), skillName, `Skill for ${repoName}`)
    }
    return { repoDir, agentsDir }
  }

  test("full flow: tool args → scan → register → inject", async () => {
    await loadModule()
    const { repoDir } = createTestRepo("full-flow-repo", "full-flow-skill")
    const filePath = path.join(repoDir, "src", "file.ts")
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, "content")

    const sessionID = SessionID.make("ses-integration-test-session")
    const args = { filePath }

    // Step 1: scanToolArgs (now self-injects)
    const scanResult = await Effect.runPromise(
      Effect.provide(
        Effect.provide(
          Effect.provide(
            Effect.provide(
              Effect.provide(
                DynamicSkillScanner.scanToolArgs("read", args, sessionID, "test-agent", ProviderID.make("test-provider"), ModelID.make("test-model")),
                AppFileSystem.defaultLayer,
              ),
              mockSkillLayer(),
            ),
            SessionMetadata.defaultLayer,
          ),
          mockSessionLayer(),
        ),
        mockRipgrepLayer(),
      ),
    )

    expect(scanResult.pathsFound).toBeGreaterThanOrEqual(1)
    expect(scanResult.skillsRegistered).toBeGreaterThanOrEqual(1)

    // Step 2: self-injection already happened inside scanToolArgs
    // Verify queue is cleared by calling injectDiscoveredSkills again
    const afterInject = await Effect.runPromise(
      Effect.provide(
        Effect.provide(
          Effect.provide(
            DynamicSkillScanner.injectDiscoveredSkills(sessionID),
            mockSkillLayer(),
          ),
          SessionMetadata.defaultLayer,
        ),
        mockRipgrepLayer(),
      ),
    )
    expect(afterInject.injected).toBe(0)
    expect(afterInject.skillCount).toBe(0)
  })
})

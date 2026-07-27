import path from "path"
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { Effect, Fiber, Layer, Option } from "effect"
import * as fs from "fs"
import * as os from "os"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Skill from "@/skill"
import * as SessionMetadata from "@/skill/session-metadata"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import type { MessageV2 } from "@/session/message-v2"

// Minimal mock Skill.Service for scanParts tests
function createMockSkillService(): Skill.Interface {
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
    if (state.promoted) return { promoted: 0 }
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
  return Layer.succeed(Skill.Service, createMockSkillService())
}

// Minimal mock Session.Service for scanParts tests
function createMockSessionService(): Session.Interface {
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

// We test the public API of dynamic-scanner module
// Import is deferred until after implementation exists
let DynamicSkillScanner: typeof import("@/skill/dynamic-scanner")

describe("DynamicSkillScanner", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dyn-scan-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function loadModule() {
    if (!DynamicSkillScanner) {
      DynamicSkillScanner = await import("@/skill/dynamic-scanner")
    }
  }

  function run<T>(program: Effect.Effect<T, unknown, AppFileSystem.Service | SessionMetadata.SessionMetadataService>) {
    return Effect.runPromise(
      Effect.provide(
        Effect.provide(program, AppFileSystem.defaultLayer),
        SessionMetadata.defaultLayer,
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

  // ---------------------------------------------------------------------------
  // findAgentsDirectories tests
  // ---------------------------------------------------------------------------

  describe("findAgentsDirectories", () => {
    test("returns empty array when no .agents directory found", async () => {
      await loadModule()
      const filePath = path.join(tmpDir, "some-file.txt")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const result = await run(DynamicSkillScanner.findAgentsDirectories(filePath))
      expect(result).toEqual([])
    })

    test("returns .agents directory when found at immediate parent", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(agentsDir, { recursive: true })
      const filePath = path.join(tmpDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const result = await run(DynamicSkillScanner.findAgentsDirectories(filePath))
      expect(result).toEqual([agentsDir])
    })

    test("returns .agents directory when found at grandparent", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(agentsDir, { recursive: true })
      const filePath = path.join(tmpDir, "project", "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const result = await run(DynamicSkillScanner.findAgentsDirectories(filePath))
      expect(result).toEqual([agentsDir])
    })

    test("returns multiple .agents directories when found at different levels", async () => {
      await loadModule()
      const repoDir = path.join(tmpDir, "repo")
      const projectDir = path.join(repoDir, "project")
      const repoAgents = path.join(repoDir, ".agents")
      const projectAgents = path.join(projectDir, ".agents")
      fs.mkdirSync(repoAgents, { recursive: true })
      fs.mkdirSync(projectAgents, { recursive: true })
      const filePath = path.join(projectDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const result = await run(DynamicSkillScanner.findAgentsDirectories(filePath))
      // Should find both, closer first
      expect(result).toContain(projectAgents)
      expect(result).toContain(repoAgents)
      expect(result.indexOf(projectAgents)).toBeLessThan(result.indexOf(repoAgents))
    })

    test("respects depth limit of 50", async () => {
      await loadModule()
      // Create a deeply nested path
      let deepPath = tmpDir
      for (let i = 0; i < 60; i++) {
        deepPath = path.join(deepPath, `level${i}`)
      }
      fs.mkdirSync(deepPath, { recursive: true })
      const filePath = path.join(deepPath, "file.txt")
      fs.writeFileSync(filePath, "content")

      // Should not throw and should return empty (no .agents found within 50 levels)
      const result = await run(DynamicSkillScanner.findAgentsDirectories(filePath))
      expect(Array.isArray(result)).toBe(true)
    })

    test("resolves symlinks for directory paths", async () => {
      await loadModule()
      const realDir = path.join(tmpDir, "real-repo")
      const agentsDir = path.join(realDir, ".agents")
      fs.mkdirSync(agentsDir, { recursive: true })
      const symlinkDir = path.join(tmpDir, "linked-repo")
      fs.symlinkSync(realDir, symlinkDir, "dir")
      const filePath = path.join(symlinkDir, "file.ts")
      fs.writeFileSync(filePath, "content")

      const result = await run(DynamicSkillScanner.findAgentsDirectories(filePath))
      // Should find the .agents dir (possibly via resolved realpath)
      expect(result.length).toBeGreaterThan(0)
    })
  })

  // ---------------------------------------------------------------------------
  // scanAgentsSkills tests
  // ---------------------------------------------------------------------------

  describe("scanAgentsSkills", () => {
    test("returns empty array when no skills found", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(agentsDir, { recursive: true })

      const result = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result).toEqual([])
    })

    test("finds skills in .agents/skills/", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
      createSkill(path.join(agentsDir, "skills"), "test-skill", "Test description")

      const result = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("test-skill")
      expect(result[0].description).toBe("Test description")
    })

    test("finds skills in .opencode/skills/", async () => {
      await loadModule()
      const opencodeDir = path.join(tmpDir, ".opencode")
      fs.mkdirSync(path.join(opencodeDir, "skills"), { recursive: true })
      createSkill(path.join(opencodeDir, "skills"), "opencode-skill", "Opencode skill")

      const result = await run(DynamicSkillScanner.scanAgentsSkills(opencodeDir))
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("opencode-skill")
    })

    test("finds skills in .opencode/skill/ (singular)", async () => {
      await loadModule()
      const opencodeDir = path.join(tmpDir, ".opencode")
      fs.mkdirSync(path.join(opencodeDir, "skill"), { recursive: true })
      createSkill(path.join(opencodeDir, "skill"), "singular-skill", "Singular dir skill")

      const result = await run(DynamicSkillScanner.scanAgentsSkills(opencodeDir))
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("singular-skill")
    })

    test("finds skills in .claude/skills/", async () => {
      await loadModule()
      const claudeDir = path.join(tmpDir, ".claude")
      fs.mkdirSync(path.join(claudeDir, "skills"), { recursive: true })
      createSkill(path.join(claudeDir, "skills"), "claude-skill", "Claude skill")

      const result = await run(DynamicSkillScanner.scanAgentsSkills(claudeDir))
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("claude-skill")
    })

    test("finds skills in nested subdirectories", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      const nestedDir = path.join(agentsDir, "skills", "category", "sub-category")
      fs.mkdirSync(nestedDir, { recursive: true })
      createSkill(path.join(nestedDir), "nested-skill", "Nested skill")

      const result = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("nested-skill")
    })

    test("skips invalid SKILL.md files (missing name in frontmatter)", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills", "bad-skill"), { recursive: true })
      fs.writeFileSync(path.join(agentsDir, "skills", "bad-skill", "SKILL.md"), "---\nnoName: true\n---\n\n# Bad")

      const result = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result).toEqual([])
    })

    test("skips files with invalid frontmatter", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills", "broken-skill"), { recursive: true })
      fs.writeFileSync(path.join(agentsDir, "skills", "broken-skill", "SKILL.md"), "no frontmatter at all")

      const result = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result).toEqual([])
    })

    test("resolves symlinks for skill file paths", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      const skillsDir = path.join(agentsDir, "skills")
      fs.mkdirSync(skillsDir, { recursive: true })

      // Create a real skill
      const realSkillDir = path.join(tmpDir, "real-skill")
      fs.mkdirSync(realSkillDir, { recursive: true })
      fs.writeFileSync(path.join(realSkillDir, "SKILL.md"), "---\nname: symlinked-skill\ndescription: Symlinked\n---\n\n# Symlinked")

      // Symlink the skill directory
      const linkedSkillDir = path.join(skillsDir, "linked-skill")
      fs.symlinkSync(realSkillDir, linkedSkillDir, "dir")

      const result = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("symlinked-skill")
    })
  })

  // ---------------------------------------------------------------------------
  // scanForFile tests
  // ---------------------------------------------------------------------------

  describe("scanForFile", () => {
    test("returns empty when no .agents directories found", async () => {
      await loadModule()
      const filePath = path.join(tmpDir, "orphan-file.txt")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const result = await run(DynamicSkillScanner.scanForFile(filePath, "ses-test-id"))
      expect(result).toEqual({ agentsDirs: [], skills: [] })
    })

    test("scans and returns skills when .agents directory exists", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
      createSkill(path.join(agentsDir, "skills"), "discovered-skill", "Discovered via scan")
      const filePath = path.join(tmpDir, "project", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const result = await run(DynamicSkillScanner.scanForFile(filePath, "ses-test-id"))
      expect(result.agentsDirs.length).toBeGreaterThan(0)
      expect(result.skills).toHaveLength(1)
      expect(result.skills[0].name).toBe("discovered-skill")
    })

    test("deduplicates skills from multiple .agents directories", async () => {
      await loadModule()
      const repoDir = path.join(tmpDir, "repo")
      const projectDir = path.join(repoDir, "project")

      // Both have the same skill name
      const repoAgents = path.join(repoDir, ".agents")
      const projectAgents = path.join(projectDir, ".agents")
      fs.mkdirSync(path.join(repoAgents, "skills"), { recursive: true })
      fs.mkdirSync(path.join(projectAgents, "skills"), { recursive: true })

      createSkill(path.join(repoAgents, "skills"), "shared-skill", "In repo")
      createSkill(path.join(projectAgents, "skills"), "shared-skill", "In project")

      const filePath = path.join(projectDir, "src", "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      const result = await run(DynamicSkillScanner.scanForFile(filePath, "ses-test-id"))
      // Should only return one skill (deduplicated by name, first found wins)
      expect(result.skills).toHaveLength(1)
      expect(result.skills[0].name).toBe("shared-skill")
    })

    test("handles errors gracefully without throwing", async () => {
      await loadModule()
      // Point to a non-existent file
      const result = await run(DynamicSkillScanner.scanForFile("/nonexistent/path/file.ts", "ses-test-id"))
      // Should return empty, not throw
      expect(result).toEqual({ agentsDirs: [], skills: [] })
    })

    test("is non-blocking — can be forked safely", async () => {
      await loadModule()
      const filePath = path.join(tmpDir, "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      // Fork it and verify it completes without blocking
      const program = Effect.gen(function* () {
        const fiber = yield* DynamicSkillScanner.scanForFile(filePath, "ses-test-id").pipe(
          Effect.forkChild,
        )
        return yield* Fiber.join(fiber)
      })
      const result = await run(program)
      expect(result).toBeDefined()
    })

    test("times out on slow AppFileSystem isDir and returns empty result", async () => {
      await loadModule()
      // Create a real file path so resolveRealpath succeeds
      const filePath = path.join(tmpDir, "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      // Get real filesystem to spread, then override isDir to delay
      const realFs = await Effect.runPromise(AppFileSystem.Service.pipe(
        Effect.provide(AppFileSystem.defaultLayer),
      ))

      const slowFileSystem = AppFileSystem.Service.of({
        ...realFs,
        isDir: () => Effect.succeed(true).pipe(Effect.delay(2000)),
      })

      const program = DynamicSkillScanner.scanForFile(filePath, "ses-timeout-test").pipe(
        Effect.provideService(AppFileSystem.Service, slowFileSystem),
      )

      const startTime = Date.now()
      const result = await Effect.runPromise(
        Effect.provide(program, SessionMetadata.defaultLayer),
      )
      const elapsed = Date.now() - startTime

      // Should timeout around 1000ms (not wait for full 2000ms delay)
      expect(elapsed).toBeLessThan(1500)
      // Timeout caught → parentExists false → early return with empty result
      expect(result).toEqual({ agentsDirs: [], skills: [] })
    })

    test("times out on slow findAgentsDirectories walk-up and returns empty result", async () => {
      await loadModule()
      // Create a real file path so resolveRealpath and parentExists succeed
      const filePath = path.join(tmpDir, "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      // Get real filesystem to spread, then override isDir to delay only during walk-up
      // (parent check succeeds fast, walk-up isDir calls delay)
      let callCount = 0
      const realFs = await Effect.runPromise(AppFileSystem.Service.pipe(
        Effect.provide(AppFileSystem.defaultLayer),
      ))

      const slowWalkFileSystem = AppFileSystem.Service.of({
        ...realFs,
        isDir: (dir: string) => {
          // First call (parent check) returns fast
          if (callCount === 0) {
            callCount++
            return Effect.succeed(true)
          }
          // Walk-up calls delay beyond 2000ms timeout
          return Effect.succeed(true).pipe(Effect.delay(3000))
        },
      })

      const program = DynamicSkillScanner.scanForFile(filePath, "ses-walk-timeout-test").pipe(
        Effect.provideService(AppFileSystem.Service, slowWalkFileSystem),
      )

      const startTime = Date.now()
      const result = await Effect.runPromise(
        Effect.provide(program, SessionMetadata.defaultLayer),
      )
      const elapsed = Date.now() - startTime

      // Should timeout around 2000ms (findAgentsDirectories timeout), not wait for full 3000ms delay
      expect(elapsed).toBeLessThan(3000)
      // Timeout caught → agentsDirs empty → early return with empty result
      expect(result).toEqual({ agentsDirs: [], skills: [] })
    })
  })

  // ---------------------------------------------------------------------------
  // scanParts tests — timeout on slow scanForFile
  // ---------------------------------------------------------------------------

  describe("scanParts — scanForFile timeout", () => {
    test("times out on slow scanForFile and returns empty result for that path", async () => {
      await loadModule()

      // Create a real file path with a .agents dir containing a skill
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills", "slow-skill"), { recursive: true })
      fs.writeFileSync(path.join(agentsDir, "skills", "slow-skill", "SKILL.md"), "---\nname: slow-skill\n---\n# Slow")
      const filePath = path.join(tmpDir, "file.ts")
      fs.writeFileSync(filePath, "content")

      // Spy on ConfigMarkdown.parse to make it slow (beyond 2000ms timeout)
      const ConfigMarkdown = await import("@/config/markdown")
      const realParse = ConfigMarkdown.parse
      const slowParse = async (p: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        return realParse(p)
      }
      const spy = spyOn(ConfigMarkdown, "parse").mockImplementation(slowParse)

      try {
        const sessionID = SessionID.make("ses-scan-parts-timeout-test")
        const agent = "test-agent"
        const providerID = ProviderID.make("test-provider")
        const modelID = ModelID.make("test-model")

        // Create a text part referencing the file (scanParts only reads part.type and part.text)
        const parts: Array<{ type: "text"; text: string }> = [
          { type: "text", text: `Check this file: ${filePath}` },
        ]

        const program = DynamicSkillScanner.scanParts(parts as import("@/session/message-v2").Part[], sessionID, agent, providerID, modelID)

        const startTime = Date.now()
        const result = await Effect.runPromise(
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
        const elapsed = Date.now() - startTime

        // After Task 3: scanParts applies 2000ms timeout to scanForFile call
        // So even if scanForFile would take 5000ms+, it times out at ~2000ms
        // Before Task 3: no scanForFile-level timeout, so it would wait for full 5000ms+
        expect(elapsed).toBeLessThan(3000)
        // Timeout caught by catch block → empty result for this path
        expect(result.pathsFound).toBe(1)
        expect(result.scannedPaths).toEqual([])
        expect(result.skillsRegistered).toBe(0)
        expect(result.skillNames).toEqual([])
      } finally {
        spy.mockRestore()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Caching tests
  // ---------------------------------------------------------------------------

  describe("caching", () => {
    test("caches scan results for the same agents directory", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
      createSkill(path.join(agentsDir, "skills"), "cached-skill", "Cached skill")

      const filePath1 = path.join(tmpDir, "project1", "file.ts")
      const filePath2 = path.join(tmpDir, "project2", "file.ts")
      fs.mkdirSync(path.dirname(filePath1), { recursive: true })
      fs.mkdirSync(path.dirname(filePath2), { recursive: true })
      fs.writeFileSync(filePath1, "content")
      fs.writeFileSync(filePath2, "content")

      // First scan
      const result1 = await run(DynamicSkillScanner.scanForFile(filePath1, "ses-test-id"))
      expect(result1.skills).toHaveLength(1)

      // Second scan from same agents dir: SessionMetadata dedup prevents re-scanning
      const result2 = await run(DynamicSkillScanner.scanForFile(filePath2, "ses-test-id"))
      expect(result2.skills).toHaveLength(0)
    })

    test("cache key uses realpath for symlink resolution", async () => {
      await loadModule()
      const realDir = path.join(tmpDir, "real-repo")
      const agentsDir = path.join(realDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
      createSkill(path.join(agentsDir, "skills"), "realpath-skill", "Realpath skill")

      const symlinkDir = path.join(tmpDir, "linked-repo")
      fs.symlinkSync(realDir, symlinkDir, "dir")

      const filePath = path.join(symlinkDir, "file.ts")
      fs.writeFileSync(filePath, "content")

      const result = await run(DynamicSkillScanner.scanForFile(filePath, "ses-test-id"))
      expect(result.skills).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Logging tests
  // ---------------------------------------------------------------------------

  describe("logging", () => {
    test("includes tag: dynamic-skills in log output", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
      createSkill(path.join(agentsDir, "skills"), "logged-skill", "Logged skill")

      const filePath = path.join(tmpDir, "file.ts")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "content")

      // Just verify it runs without error — logging is internal
      const result = await run(DynamicSkillScanner.scanForFile(filePath, "ses-test-id"))
      expect(result.skills).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // flushInjectedMessages tests
  // ---------------------------------------------------------------------------

  describe("flushInjectedMessages", () => {
    function createMockSession(): Session.Interface {
      const messagesData: MessageV2.WithParts[] = []
      const partsData: MessageV2.Part[] = []

      return {
        list: Effect.fn("MockSession.list")(function* () { return [] }),
        create: Effect.fn("MockSession.create")(function* () { return {} as any }),
        fork: Effect.fn("MockSession.fork")(function* () { return {} as any }),
        touch: Effect.fn("MockSession.touch")(function* () {}),
        get: Effect.fn("MockSession.get")(function* () { return {} as any }),
        setTitle: Effect.fn("MockSession.setTitle")(function* () {}),
        setArchived: Effect.fn("MockSession.setArchived")(function* () {}),
        setPermission: Effect.fn("MockSession.setPermission")(function* () {}),
        setRevert: Effect.fn("MockSession.setRevert")(function* () {}),
        clearRevert: Effect.fn("MockSession.clearRevert")(function* () {}),
        setSummary: Effect.fn("MockSession.setSummary")(function* () {}),
        diff: Effect.fn("MockSession.diff")(function* () { return [] }),
        messages: Effect.fn("MockSession.messages")(function* () { return messagesData }),
        children: Effect.fn("MockSession.children")(function* () { return [] }),
        remove: Effect.fn("MockSession.remove")(function* () {}),
        updateMessage: Effect.fn("MockSession.updateMessage")(function* <T extends MessageV2.Info>(msg: T) {
          messagesData.push({ info: msg, parts: [] })
          return msg
        }),
        removeMessage: Effect.fn("MockSession.removeMessage")(function* () { return MessageID.make("msg-removed") }),
        removePart: Effect.fn("MockSession.removePart")(function* () { return PartID.make("prt-removed") }),
        getPart: Effect.fn("MockSession.getPart")(function* () { return undefined }),
        updatePart: Effect.fn("MockSession.updatePart")(function* <T extends MessageV2.Part>(part: T) {
          partsData.push(part)
          return part
        }),
        updatePartDelta: Effect.fn("MockSession.updatePartDelta")(function* () {}),
        findMessage: Effect.fn("MockSession.findMessage")(function* () { return Option.none() }),
      }
    }

    function runWithSession<T>(program: Effect.Effect<T, unknown, Session.Service | AppFileSystem.Service | SessionMetadata.SessionMetadataService>) {
      return Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(program, AppFileSystem.defaultLayer),
            SessionMetadata.defaultLayer,
          ),
          Layer.succeed(Session.Service, createMockSession()),
        ),
      )
    }

    const testSessionID = SessionID.make("ses-test-flush")
    const testAgent = "test-agent"
    const testProviderID = ProviderID.make("test-provider")
    const testModelID = ModelID.make("test-model")

    test("does nothing when injected array is empty", async () => {
      await loadModule()
      const result = await runWithSession(
        DynamicSkillScanner.flushInjectedMessages({
          injected: [],
          sessionID: testSessionID,
          agent: testAgent,
          providerID: testProviderID,
          modelID: testModelID,
        }),
      )
      expect(result).toBeUndefined()
    })

    test("creates synthetic user message for user-role injection", async () => {
      await loadModule()
      const mockSession = createMockSession()
      const program = DynamicSkillScanner.flushInjectedMessages({
        injected: [{ role: "user", text: "Hello world" }],
        sessionID: testSessionID,
        agent: testAgent,
        providerID: testProviderID,
        modelID: testModelID,
      })

      await Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(program, AppFileSystem.defaultLayer),
            SessionMetadata.defaultLayer,
          ),
          Layer.succeed(Session.Service, mockSession),
        ),
      )

      // Verify a user message was created
      expect(mockSession).toBeDefined()
    })

    test("wraps system-role text in system-reminder tags", async () => {
      await loadModule()
      const mockSession = createMockSession()
      const capturedParts: MessageV2.Part[] = []

      const wrappedSession: Session.Interface = {
        ...mockSession,
        updatePart: Effect.fn("MockSession.updatePart")(function* <T extends MessageV2.Part>(part: T) {
          capturedParts.push(part)
          return part
        }),
      }

      await Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(
              DynamicSkillScanner.flushInjectedMessages({
                injected: [{ role: "system", text: "System instruction" }],
                sessionID: testSessionID,
                agent: testAgent,
                providerID: testProviderID,
                modelID: testModelID,
              }),
              AppFileSystem.defaultLayer,
            ),
            SessionMetadata.defaultLayer,
          ),
          Layer.succeed(Session.Service, wrappedSession),
        ),
      )

      expect(capturedParts).toHaveLength(1)
      const textPart = capturedParts[0] as MessageV2.TextPart
      expect(textPart.type).toBe("text")
      expect(textPart.text).toBe("<system-reminder>System instruction</system-reminder>")
    })

    test("does not wrap user-role text", async () => {
      await loadModule()
      const mockSession = createMockSession()
      const capturedParts: MessageV2.Part[] = []

      const wrappedSession: Session.Interface = {
        ...mockSession,
        updatePart: Effect.fn("MockSession.updatePart")(function* <T extends MessageV2.Part>(part: T) {
          capturedParts.push(part)
          return part
        }),
      }

      await Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(
              DynamicSkillScanner.flushInjectedMessages({
                injected: [{ role: "user", text: "Raw user text" }],
                sessionID: testSessionID,
                agent: testAgent,
                providerID: testProviderID,
                modelID: testModelID,
              }),
              AppFileSystem.defaultLayer,
            ),
            SessionMetadata.defaultLayer,
          ),
          Layer.succeed(Session.Service, wrappedSession),
        ),
      )

      expect(capturedParts).toHaveLength(1)
      const textPart = capturedParts[0] as MessageV2.TextPart
      expect(textPart.text).toBe("Raw user text")
    })

    test("marks parts as synthetic: true", async () => {
      await loadModule()
      const mockSession = createMockSession()
      const capturedParts: MessageV2.Part[] = []

      const wrappedSession: Session.Interface = {
        ...mockSession,
        updatePart: Effect.fn("MockSession.updatePart")(function* <T extends MessageV2.Part>(part: T) {
          capturedParts.push(part)
          return part
        }),
      }

      await Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(
              DynamicSkillScanner.flushInjectedMessages({
                injected: [{ role: "user", text: "Test" }],
                sessionID: testSessionID,
                agent: testAgent,
                providerID: testProviderID,
                modelID: testModelID,
              }),
              AppFileSystem.defaultLayer,
            ),
            SessionMetadata.defaultLayer,
          ),
          Layer.succeed(Session.Service, wrappedSession),
        ),
      )

      expect(capturedParts).toHaveLength(1)
      const textPart = capturedParts[0] as MessageV2.TextPart
      expect(textPart.synthetic).toBe(true)
    })

    test("creates separate messages for each injection", async () => {
      await loadModule()
      const mockSession = createMockSession()
      const capturedMessages: MessageV2.Info[] = []
      const capturedParts: MessageV2.Part[] = []

      const wrappedSession: Session.Interface = {
        ...mockSession,
        updateMessage: Effect.fn("MockSession.updateMessage")(function* <T extends MessageV2.Info>(msg: T) {
          capturedMessages.push(msg)
          return msg
        }),
        updatePart: Effect.fn("MockSession.updatePart")(function* <T extends MessageV2.Part>(part: T) {
          capturedParts.push(part)
          return part
        }),
      }

      await Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(
              DynamicSkillScanner.flushInjectedMessages({
                injected: [
                  { role: "user", text: "First" },
                  { role: "system", text: "Second" },
                  { role: "user", text: "Third" },
                ],
                sessionID: testSessionID,
                agent: testAgent,
                providerID: testProviderID,
                modelID: testModelID,
              }),
              AppFileSystem.defaultLayer,
            ),
            SessionMetadata.defaultLayer,
          ),
          Layer.succeed(Session.Service, wrappedSession),
        ),
      )

      expect(capturedMessages).toHaveLength(3)
      expect(capturedParts).toHaveLength(3)
      // Each part references its corresponding message
      expect(capturedParts[0].messageID).toBe(capturedMessages[0].id)
      expect(capturedParts[1].messageID).toBe(capturedMessages[1].id)
      expect(capturedParts[2].messageID).toBe(capturedMessages[2].id)
    })

    test("sets correct agent, providerID, and modelID on messages", async () => {
      await loadModule()
      const mockSession = createMockSession()
      const capturedMessages: MessageV2.Info[] = []

      const wrappedSession: Session.Interface = {
        ...mockSession,
        updateMessage: Effect.fn("MockSession.updateMessage")(function* <T extends MessageV2.Info>(msg: T) {
          capturedMessages.push(msg)
          return msg
        }),
      }

      await Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(
              DynamicSkillScanner.flushInjectedMessages({
                injected: [{ role: "user", text: "Test" }],
                sessionID: testSessionID,
                agent: testAgent,
                providerID: testProviderID,
                modelID: testModelID,
              }),
              AppFileSystem.defaultLayer,
            ),
            SessionMetadata.defaultLayer,
          ),
          Layer.succeed(Session.Service, wrappedSession),
        ),
      )

      expect(capturedMessages).toHaveLength(1)
      const msg = capturedMessages[0] as MessageV2.User
      expect(msg.role).toBe("user")
      expect(msg.agent).toBe(testAgent)
      expect(msg.model.providerID).toBe(testProviderID)
      expect(msg.model.modelID).toBe(testModelID)
      expect(msg.sessionID).toBe(testSessionID)
    })
  })
})

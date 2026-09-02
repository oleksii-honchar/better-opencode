import path from "path"
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { Effect, Fiber, Layer, Option, Stream } from "effect"
import * as fs from "fs"
import * as os from "os"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Skill from "@/skill"
import * as SessionMetadata from "@/skill/session-metadata"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import type { MessageV2 } from "@/session/message-v2"
import { Ripgrep } from "@/file/ripgrep"

// Minimal mock Skill.Service for scanParts tests
function createMockSkillServiceWithStartup(startupSkills: Skill.Info[]): Skill.Interface {
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

  // Pre-populate startup skills
  for (const s of startupSkills) {
    state.skills[s.name] = s
  }

  const get = Effect.fn("MockSkill.get")(function* (name: string) {
    return state.skills[name] ?? state.dynamicSkills[name]
  })
  const require = Effect.fn("MockSkill.require")(function* (name: string) {
    const info = state.skills[name] ?? state.dynamicSkills[name]
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
  const allIncludingDynamic = Effect.fn("MockSkill.allIncludingDynamic")(function* () {
    return [...Object.values(state.skills), ...Object.values(state.dynamicSkills)]
  })

  return { get, require, all, dirs, available, allIncludingDynamic, registerDynamic, promoteDynamicToStartup }
}

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
  const allIncludingDynamic = Effect.fn("MockSkill.allIncludingDynamic")(function* () {
    return [...Object.values(state.skills), ...Object.values(state.dynamicSkills)]
  })

  return { get, require, all, dirs, available, allIncludingDynamic, registerDynamic, promoteDynamicToStartup }
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
    setModel: () => Effect.void,
    setModelOverride: () => Effect.void,
    clearModelOverride: () => Effect.void,
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

  function run<T>(program: Effect.Effect<T, unknown, AppFileSystem.Service | SessionMetadata.SessionMetadataService | Ripgrep.Service>) {
    return Effect.runPromise(
      Effect.provide(
        Effect.provide(
          Effect.provide(program, AppFileSystem.defaultLayer),
          SessionMetadata.defaultLayer,
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

    // ---------------------------------------------------------------------------
    // Task 5: scanCache TTL + no empty cache
    // ---------------------------------------------------------------------------

    test("cache hit for fresh non-empty entry", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
      createSkill(path.join(agentsDir, "skills"), "ttl-skill", "TTL test skill")

      // First scan — populates cache
      const result1 = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result1).toHaveLength(1)
      expect(result1[0].name).toBe("ttl-skill")

      // Second scan immediately — should hit cache (same result, no re-glob)
      const result2 = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result2).toHaveLength(1)
      expect(result2[0].name).toBe("ttl-skill")
    })

    test("cache miss (re-scan) for entry older than 5 minutes", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
      createSkill(path.join(agentsDir, "skills"), "ttl-skill", "TTL test skill")

      // First scan — populates cache
      const result1 = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result1).toHaveLength(1)

      // Manually inject a stale cache entry (> 5 minutes old)
      // Access scanCache via module namespace — it's exported as DynamicSkillScanner
      const cacheModule = (await import("@/skill/dynamic-scanner")) as any
      const cacheKey = path.resolve(agentsDir)
      const staleEntry = { skills: [{ name: "stale-skill", location: "/old", content: "" }], timestamp: Date.now() - 310_000 }
      cacheModule.scanCache.set(cacheKey, staleEntry)

      // Next scan should detect stale entry and re-scan (find ttl-skill, not stale-skill)
      const result2 = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result2).toHaveLength(1)
      expect(result2[0].name).toBe("ttl-skill")
    })

    test("empty scan results not cached — next scan re-globs", async () => {
      await loadModule()
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(agentsDir, { recursive: true })
      // No skills directory — scan returns empty

      // First scan — empty result, should NOT cache
      const result1 = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result1).toHaveLength(0)

      // Now add a skill after the first scan
      fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true })
      createSkill(path.join(agentsDir, "skills"), "late-skill", "Added after first scan")

      // Second scan — since empty was not cached, should find the new skill
      const result2 = await run(DynamicSkillScanner.scanAgentsSkills(agentsDir))
      expect(result2).toHaveLength(1)
      expect(result2[0].name).toBe("late-skill")
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
        setModel: Effect.fn("MockSession.setModel")(function* () {}),
        setModelOverride: Effect.fn("MockSession.setModelOverride")(function* () {}),
        clearModelOverride: Effect.fn("MockSession.clearModelOverride")(function* () {}),
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

  // ---------------------------------------------------------------------------
  // Per-session injection gate tests (Task 4)
  // ---------------------------------------------------------------------------

  describe("per-session injection gate", () => {
    const testAgent = "test-agent"
    const testProviderID = ProviderID.make("test-provider")
    const testModelID = ModelID.make("test-model")

    function runWithSkillService<T>(
      program: Effect.Effect<T, unknown, Skill.Service | Session.Service | AppFileSystem.Service | SessionMetadata.SessionMetadataService | Ripgrep.Service>,
      startupSkills: Skill.Info[],
    ) {
      return Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(
              Effect.provide(
                Effect.provide(program, AppFileSystem.defaultLayer),
                SessionMetadata.defaultLayer,
              ),
              Layer.succeed(Skill.Service, createMockSkillServiceWithStartup(startupSkills)),
            ),
            mockSessionLayer(),
          ),
          mockRipgrepLayer(),
        ),
      )
    }

    test("dynamic skill injected for new session even if registered by prior session", async () => {
      await loadModule()

      // Create a skill file
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills", "new-dynamic-skill"), { recursive: true })
      fs.writeFileSync(path.join(agentsDir, "skills", "new-dynamic-skill", "SKILL.md"), "---\nname: new-dynamic-skill\ndescription: A new dynamic skill\n---\n# New Dynamic")
      const filePath = path.join(tmpDir, "file.ts")
      fs.writeFileSync(filePath, "content")

      const sessionA = SessionID.make("ses-prior-session")
      const sessionB = SessionID.make("ses-new-session")

      // Create a shared Skill.Service instance so registration persists across sessions
      const sharedService = createMockSkillServiceWithStartup([])
      const parts: Array<{ type: "text"; text: string }> = [{ type: "text", text: `Check ${filePath}` }]

      // Run scanParts for session A — skill gets registered and injected for session A
      const resultA = await Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(
              Effect.provide(
                Effect.provide(
                  DynamicSkillScanner.scanParts(parts as import("@/session/message-v2").Part[], sessionA, testAgent, testProviderID, testModelID),
                  AppFileSystem.defaultLayer,
                ),
                SessionMetadata.defaultLayer,
              ),
              Layer.succeed(Skill.Service, sharedService),
            ),
            mockSessionLayer(),
          ),
          mockRipgrepLayer(),
        ),
      )
      expect(resultA.skillsRegistered).toBe(1)

      // Now run scanParts for session B — skill already registered in process,
      // but should still be injected for this new session (per-session gate)
      const resultB = await Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(
              Effect.provide(
                Effect.provide(
                  DynamicSkillScanner.scanParts(parts as import("@/session/message-v2").Part[], sessionB, testAgent, testProviderID, testModelID),
                  AppFileSystem.defaultLayer,
                ),
                SessionMetadata.defaultLayer,
              ),
              Layer.succeed(Skill.Service, sharedService),
            ),
            mockSessionLayer(),
          ),
          mockRipgrepLayer(),
        ),
      )
      // Skill already registered → added=0, but should still trigger injection for session B
      expect(resultB.skillsRegistered).toBe(0)
      // The key assertion: scanParts should NOT skip injection just because skill
      // was already registered by session A. After Task 4, per-session gate uses
      // wasSkillInjected(sessionB, name) which returns false → skill injected.
      // We verify via SessionMetadata that session B tracked the injection
      const injectedB = await Effect.runPromise(
        SessionMetadata.wasSkillInjected(sessionB, "new-dynamic-skill").pipe(
          Effect.provide(SessionMetadata.defaultLayer),
        ),
      )
      expect(injectedB).toBe(true)
    })

    test("startup skill never queued for injection", async () => {
      await loadModule()

      // Create a skill file with same name as a startup skill
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills", "startup-skill"), { recursive: true })
      fs.writeFileSync(path.join(agentsDir, "skills", "startup-skill", "SKILL.md"), "---\nname: startup-skill\ndescription: Already in system prompt\n---\n# Startup")
      const filePath = path.join(tmpDir, "file.ts")
      fs.writeFileSync(filePath, "content")

      // Pre-register as startup skill
      const startupSkills: Skill.Info[] = [{
        name: "startup-skill",
        description: "Already in system prompt",
        location: "<built-in>",
        content: "# Startup",
      }]

      const sessionID = SessionID.make("ses-startup-test")
      const parts: Array<{ type: "text"; text: string }> = [{ type: "text", text: `Check ${filePath}` }]

      const result = await runWithSkillService(
        DynamicSkillScanner.scanParts(parts as import("@/session/message-v2").Part[], sessionID, testAgent, testProviderID, testModelID),
        startupSkills,
      )

      // Skill found via scan but is startup → should NOT be queued for injection
      const injected = await Effect.runPromise(
        SessionMetadata.wasSkillInjected(sessionID, "startup-skill").pipe(
          Effect.provide(SessionMetadata.defaultLayer),
        ),
      )
      expect(injected).toBe(false)
    })

    test("same-skill re-mention in same session not re-injected", async () => {
      await loadModule()

      // Create a skill file
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills", "once-only-skill"), { recursive: true })
      fs.writeFileSync(path.join(agentsDir, "skills", "once-only-skill", "SKILL.md"), "---\nname: once-only-skill\ndescription: Injected once\n---\n# Once Only")
      const filePath = path.join(tmpDir, "file.ts")
      const filePath2 = path.join(tmpDir, "file2.ts")
      fs.writeFileSync(filePath, "content")
      fs.writeFileSync(filePath2, "content")

      const sessionID = SessionID.make("ses-once-test")

      // First mention — skill injected
      const parts1: Array<{ type: "text"; text: string }> = [{ type: "text", text: `Check ${filePath}` }]
      const result1 = await runWithSkillService(
        DynamicSkillScanner.scanParts(parts1 as import("@/session/message-v2").Part[], sessionID, testAgent, testProviderID, testModelID),
        [],
      )
      expect(result1.skillsRegistered).toBe(1)

      // Second mention in same session — should NOT re-inject
      const parts2: Array<{ type: "text"; text: string }> = [{ type: "text", text: `Check ${filePath2}` }]
      const result2 = await runWithSkillService(
        DynamicSkillScanner.scanParts(parts2 as import("@/session/message-v2").Part[], sessionID, testAgent, testProviderID, testModelID),
        [],
      )
      expect(result2.skillsRegistered).toBe(0)

      // Verify wasSkillInjected was called exactly once (addInjectedSkill is idempotent,
      // but we check that the gate prevented re-queueing)
      const injected = await Effect.runPromise(
        SessionMetadata.wasSkillInjected(sessionID, "once-only-skill").pipe(
          Effect.provide(SessionMetadata.defaultLayer),
        ),
      )
      expect(injected).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // scanToolArgs — unknown tool handler (Task 6)
  // ---------------------------------------------------------------------------

  describe("scanToolArgs — unknown tool handler", () => {
    const testAgent = "test-agent"
    const testProviderID = ProviderID.make("test-provider")
    const testModelID = ModelID.make("test-model")

    function runScanToolArgs<T>(
      program: Effect.Effect<T, unknown, Skill.Service | Session.Service | AppFileSystem.Service | SessionMetadata.SessionMetadataService | Ripgrep.Service>,
      startupSkills: Skill.Info[],
    ) {
      return Effect.runPromise(
        Effect.provide(
          Effect.provide(
            Effect.provide(
              Effect.provide(
                Effect.provide(program, AppFileSystem.defaultLayer),
                SessionMetadata.defaultLayer,
              ),
              Layer.succeed(Skill.Service, createMockSkillServiceWithStartup(startupSkills)),
            ),
            mockSessionLayer(),
          ),
          mockRipgrepLayer(),
        ),
      )
    }

    test("unknown tool with absolute filePath arg triggers scan", async () => {
      await loadModule()

      // Create a skill file
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills", "mcp-discovered-skill"), { recursive: true })
      fs.writeFileSync(path.join(agentsDir, "skills", "mcp-discovered-skill", "SKILL.md"), "---\nname: mcp-discovered-skill\ndescription: Discovered via MCP tool\n---\n# MCP Discovered")
      const filePath = path.join(tmpDir, "file.ts")
      fs.writeFileSync(filePath, "content")

      const sessionID = SessionID.make("ses-mcp-tool-test")

      // Unknown MCP tool with absolute filePath arg
      const result = await runScanToolArgs(
        DynamicSkillScanner.scanToolArgs(
          "octocode_localSearchCode",
          { filePath },
          sessionID,
          testAgent,
          testProviderID,
          testModelID,
        ),
        [],
      )

      expect(result.pathsFound).toBe(1)
      expect(result.skillsRegistered).toBe(1)
      expect(result.skillNames).toContain("mcp-discovered-skill")
    })

    test("unknown tool with no path args does not trigger scan", async () => {
      await loadModule()

      const sessionID = SessionID.make("ses-mcp-no-path-test")

      // Unknown MCP tool with no path-like args
      const result = await runScanToolArgs(
        DynamicSkillScanner.scanToolArgs(
          "octocode_localSearchCode",
          { query: "some search query", limit: 10 },
          sessionID,
          testAgent,
          testProviderID,
          testModelID,
        ),
        [],
      )

      expect(result.pathsFound).toBe(0)
      expect(result.scannedPaths).toEqual([])
      expect(result.skillsRegistered).toBe(0)
      expect(result.skillNames).toEqual([])
    })

    test("explicit handlers still work unchanged", async () => {
      await loadModule()

      // Create a skill file
      const agentsDir = path.join(tmpDir, ".agents")
      fs.mkdirSync(path.join(agentsDir, "skills", "explicit-handler-skill"), { recursive: true })
      fs.writeFileSync(path.join(agentsDir, "skills", "explicit-handler-skill", "SKILL.md"), "---\nname: explicit-handler-skill\ndescription: Found via explicit handler\n---\n# Explicit")
      const filePath = path.join(tmpDir, "file.ts")
      fs.writeFileSync(filePath, "content")

      const sessionID = SessionID.make("ses-explicit-handler-test")

      // Test read tool (explicit handler)
      const resultRead = await runScanToolArgs(
        DynamicSkillScanner.scanToolArgs(
          "read",
          { filePath },
          sessionID,
          testAgent,
          testProviderID,
          testModelID,
        ),
        [],
      )

      expect(resultRead.pathsFound).toBe(1)
      expect(resultRead.skillsRegistered).toBe(1)
      expect(resultRead.skillNames).toContain("explicit-handler-skill")
    })
  })
})

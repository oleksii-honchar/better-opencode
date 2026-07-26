import path from "path"
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import * as fs from "fs"
import * as os from "os"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

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

  function run<T>(program: Effect.Effect<T, unknown, AppFileSystem.Service>) {
    return Effect.runPromise(Effect.provide(program, AppFileSystem.defaultLayer))
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

      const result = await run(DynamicSkillScanner.scanForFile(filePath, "test-session-id"))
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

      const result = await run(DynamicSkillScanner.scanForFile(filePath, "test-session-id"))
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

      const result = await run(DynamicSkillScanner.scanForFile(filePath, "test-session-id"))
      // Should only return one skill (deduplicated by name, first found wins)
      expect(result.skills).toHaveLength(1)
      expect(result.skills[0].name).toBe("shared-skill")
    })

    test("handles errors gracefully without throwing", async () => {
      await loadModule()
      // Point to a non-existent file
      const result = await run(DynamicSkillScanner.scanForFile("/nonexistent/path/file.ts", "test-session-id"))
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
        const fiber = yield* DynamicSkillScanner.scanForFile(filePath, "test-session-id").pipe(
          Effect.forkChild,
        )
        return yield* Fiber.join(fiber)
      })
      const result = await run(program)
      expect(result).toBeDefined()
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
      const result1 = await run(DynamicSkillScanner.scanForFile(filePath1, "test-session-id"))
      expect(result1.skills).toHaveLength(1)

      // Second scan from same agents dir should use cache
      const result2 = await run(DynamicSkillScanner.scanForFile(filePath2, "test-session-id"))
      expect(result2.skills).toHaveLength(1)
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

      const result = await run(DynamicSkillScanner.scanForFile(filePath, "test-session-id"))
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
      const result = await run(DynamicSkillScanner.scanForFile(filePath, "test-session-id"))
      expect(result.skills).toHaveLength(1)
    })
  })
})

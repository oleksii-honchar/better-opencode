import { describe, test, expect } from "bun:test"
import { Effect, Layer, Context, Schema } from "effect"
import {
  Service as SessionMetadataService,
  DynamicSkillsMetadataClass,
  encodeMetadata,
  decodeMetadata,
  getMetadata,
  addScannedDirectory,
  addRegisteredSkill,
  wasDirectoryScanned,
  getRegisteredSkills,
  clearMetadata,
  wasSkillInjected,
  addInjectedSkill,
  layer as SessionMetadataLayer,
} from "@/skill/session-metadata"
import type { DynamicSkillsMetadata } from "@/skill/session-metadata"
import * as Storage from "@/storage/storage"
import * as Skill from "@/skill"

// Helpers not used in tests — kept for potential future use
// const encodeSync = <A>(schema: Schema.Schema<A>, input: A) => Schema.encodeSync(schema)(input)
// const decodeSync = <A>(schema: Schema.Schema<A>, input: unknown) => Schema.decodeSync(schema)(input)

// Convenience namespace for test readability
type SessionMetadataType = {
  DynamicSkillsMetadataClass: typeof DynamicSkillsMetadataClass
  encodeMetadata: typeof encodeMetadata
  decodeMetadata: typeof decodeMetadata
  getMetadata: typeof getMetadata
  addScannedDirectory: typeof addScannedDirectory
  addRegisteredSkill: typeof addRegisteredSkill
  wasDirectoryScanned: typeof wasDirectoryScanned
  getRegisteredSkills: typeof getRegisteredSkills
  clearMetadata: typeof clearMetadata
  wasSkillInjected: typeof wasSkillInjected
  addInjectedSkill: typeof addInjectedSkill
}

const SessionMetadata: SessionMetadataType = {
  DynamicSkillsMetadataClass,
  encodeMetadata,
  decodeMetadata,
  getMetadata,
  addScannedDirectory,
  addRegisteredSkill,
  wasDirectoryScanned,
  getRegisteredSkills,
  clearMetadata,
  wasSkillInjected,
  addInjectedSkill,
}

// ---------------------------------------------------------------------------
// Mock Storage Service
// ---------------------------------------------------------------------------

type StorageState = Map<string, unknown>

function createMockStorage(initial: unknown[] = []): Storage.Interface {
  const state: StorageState = new Map()
  for (const item of initial) {
    if (Array.isArray(item) && item.length >= 2 && Array.isArray(item[0])) {
      const key = (item[0] as string[]).join("/")
      state.set(key, item[1])
    }
  }

  const keyToPath = (key: string[]) => key.join("/")

  return {
    read: Effect.fn("MockStorage.read")(function* (key: string[]) {
      const path = keyToPath(key)
      const value = state.get(path)
      if (value === undefined) {
        return yield* new Storage.NotFoundError({ message: `Not found: ${path}` })
      }
      return value as never
    }),
    write: Effect.fn("MockStorage.write")(function* (key: string[], content: unknown) {
      const path = keyToPath(key)
      state.set(path, content)
    }),
    update: Effect.fn("MockStorage.update")(function* <T>(key: string[], fn: (draft: T) => void) {
      const path = keyToPath(key)
      const value = state.get(path) as T
      if (value === undefined) {
        return yield* new Storage.NotFoundError({ message: `Not found: ${path}` })
      }
      fn(value)
      state.set(path, value)
      return value
    }),
    remove: Effect.fn("MockStorage.remove")(function* (key: string[]) {
      const path = keyToPath(key)
      state.delete(path)
    }),
    list: Effect.fn("MockStorage.list")(function* () {
      return [] as string[][]
    }),
  }
}

function mockStorageLayer(initial?: unknown[]): Layer.Layer<Storage.Service> {
  return Layer.succeed(Storage.Service, createMockStorage(initial))
}

function run<T>(
  program: Effect.Effect<T, unknown, SessionMetadataService | Storage.Service>,
  initial?: unknown[],
): Promise<T> {
  return Effect.runPromise(
    Effect.provide(
      Effect.provide(program, SessionMetadataLayer),
      mockStorageLayer(initial),
    ),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionMetadata — Dynamic Skills Tracking", () => {
  const SESSION_ID = "ses_test123"

  describe("encodeMetadata/decodeMetadata", () => {
    test("encodes Set to Array and decodes back", () => {
      const input: DynamicSkillsMetadata = {
        dynamicSkillsScanned: new Set(["/repo1/.agents", "/repo2/.agents"]),
        dynamicSkillsRegistered: {
          "skill-a": {
            name: "skill-a",
            description: "Test skill A",
            location: "/repo1/.agents/skills/a/SKILL.md",
            content: "# Skill A",
          },
        },
        injectedSkills: new Set(),
      }

      const encoded = SessionMetadata.encodeMetadata(input)
      expect(encoded.dynamicSkillsScanned).toEqual(["/repo1/.agents", "/repo2/.agents"])
      expect(encoded.dynamicSkillsRegistered["skill-a"].name).toBe("skill-a")

      const decoded = SessionMetadata.decodeMetadata(encoded)
      expect(decoded.dynamicSkillsScanned).toBeInstanceOf(Set)
      expect(decoded.dynamicSkillsScanned.size).toBe(2)
      expect(decoded.dynamicSkillsRegistered["skill-a"].name).toBe("skill-a")
    })

    test("handles empty metadata", () => {
      const empty: DynamicSkillsMetadata = {
        dynamicSkillsScanned: new Set(),
        dynamicSkillsRegistered: {},
        injectedSkills: new Set(),
      }

      const encoded = SessionMetadata.encodeMetadata(empty)
      expect(encoded.dynamicSkillsScanned).toEqual([])
      expect(Object.keys(encoded.dynamicSkillsRegistered)).toHaveLength(0)

      const decoded = SessionMetadata.decodeMetadata(encoded)
      expect(decoded.dynamicSkillsScanned.size).toBe(0)
      expect(Object.keys(decoded.dynamicSkillsRegistered)).toHaveLength(0)
    })
  })

  describe("getMetadata", () => {
    test("returns empty metadata when no data stored", async () => {
      const result = await run(SessionMetadata.getMetadata(SESSION_ID))

      expect(result.dynamicSkillsScanned.size).toBe(0)
      expect(Object.keys(result.dynamicSkillsRegistered)).toHaveLength(0)
    })

    test("returns stored metadata when it exists", async () => {
      const initial: DynamicSkillsMetadata = {
        dynamicSkillsScanned: new Set(["/repo1/.agents"]),
        dynamicSkillsRegistered: {
          "skill-x": {
            name: "skill-x",
            description: "Stored skill",
            location: "/repo1/.agents/skills/x/SKILL.md",
            content: "# Skill X",
          },
        },
        injectedSkills: new Set(),
      }

      const encoded = SessionMetadata.encodeMetadata(initial)
      const result = await run(SessionMetadata.getMetadata(SESSION_ID), [[["session_dynamic_skills", SESSION_ID], encoded]])

      expect(result.dynamicSkillsScanned.size).toBe(1)
      expect(result.dynamicSkillsScanned.has("/repo1/.agents")).toBe(true)
      expect(result.dynamicSkillsRegistered["skill-x"].name).toBe("skill-x")
    })
  })

  describe("addScannedDirectory", () => {
    test("adds directory to dynamicSkillsScanned", async () => {
      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo1/.agents")
          return yield* SessionMetadata.getMetadata(SESSION_ID)
        }),
      )

      expect(result.dynamicSkillsScanned.has("/repo1/.agents")).toBe(true)
    })

    test("is idempotent — adding same directory twice doesn't duplicate", async () => {
      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo1/.agents")
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo1/.agents")
          return yield* SessionMetadata.getMetadata(SESSION_ID)
        }),
      )

      expect(result.dynamicSkillsScanned.size).toBe(1)
      expect(result.dynamicSkillsScanned.has("/repo1/.agents")).toBe(true)
    })

    test("accumulates multiple directories", async () => {
      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo1/.agents")
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo2/.agents")
          return yield* SessionMetadata.getMetadata(SESSION_ID)
        }),
      )

      expect(result.dynamicSkillsScanned.size).toBe(2)
      expect(result.dynamicSkillsScanned.has("/repo1/.agents")).toBe(true)
      expect(result.dynamicSkillsScanned.has("/repo2/.agents")).toBe(true)
    })
  })

  describe("addRegisteredSkill", () => {
    test("adds skill to dynamicSkillsRegistered", async () => {
      const skill: Skill.Info = {
        name: "test-skill",
        description: "Test",
        location: "/repo/.agents/skills/test/SKILL.md",
        content: "# Test",
      }

      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addRegisteredSkill(SESSION_ID, skill)
          return yield* SessionMetadata.getMetadata(SESSION_ID)
        }),
      )

      expect(result.dynamicSkillsRegistered["test-skill"].name).toBe("test-skill")
      expect(result.dynamicSkillsRegistered["test-skill"].location).toBe("/repo/.agents/skills/test/SKILL.md")
    })

    test("skips duplicate skill name", async () => {
      const skill1: Skill.Info = {
        name: "dup-skill",
        description: "First",
        location: "/repo1/.agents/skills/dup/SKILL.md",
        content: "# First",
      }
      const skill2: Skill.Info = {
        name: "dup-skill",
        description: "Second",
        location: "/repo2/.agents/skills/dup/SKILL.md",
        content: "# Second",
      }

      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addRegisteredSkill(SESSION_ID, skill1)
          yield* SessionMetadata.addRegisteredSkill(SESSION_ID, skill2)
          return yield* SessionMetadata.getMetadata(SESSION_ID)
        }),
      )

      expect(Object.keys(result.dynamicSkillsRegistered)).toHaveLength(1)
      expect(result.dynamicSkillsRegistered["dup-skill"].location).toBe("/repo1/.agents/skills/dup/SKILL.md")
    })

    test("accumulates multiple skills", async () => {
      const skills: Skill.Info[] = [
        { name: "a", description: "A", location: "/a/SKILL.md", content: "A" },
        { name: "b", description: "B", location: "/b/SKILL.md", content: "B" },
      ]

      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addRegisteredSkill(SESSION_ID, skills[0])
          yield* SessionMetadata.addRegisteredSkill(SESSION_ID, skills[1])
          return yield* SessionMetadata.getMetadata(SESSION_ID)
        }),
      )

      expect(Object.keys(result.dynamicSkillsRegistered)).toHaveLength(2)
      expect(result.dynamicSkillsRegistered["a"].name).toBe("a")
      expect(result.dynamicSkillsRegistered["b"].name).toBe("b")
    })
  })

  describe("wasDirectoryScanned", () => {
    test("returns false for unscanned directory", async () => {
      const result = await run(SessionMetadata.wasDirectoryScanned(SESSION_ID, "/repo1/.agents"))
      expect(result).toBe(false)
    })

    test("returns true for scanned directory", async () => {
      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo1/.agents")
          return yield* SessionMetadata.wasDirectoryScanned(SESSION_ID, "/repo1/.agents")
        }),
      )
      expect(result).toBe(true)
    })

    test("returns false for different directory", async () => {
      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo1/.agents")
          return yield* SessionMetadata.wasDirectoryScanned(SESSION_ID, "/repo2/.agents")
        }),
      )
      expect(result).toBe(false)
    })
  })

  describe("getRegisteredSkills", () => {
    test("returns all registered skills", async () => {
      const skills: Skill.Info[] = [
        { name: "x", description: "X", location: "/x/SKILL.md", content: "X" },
        { name: "y", description: "Y", location: "/y/SKILL.md", content: "Y" },
      ]

      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addRegisteredSkill(SESSION_ID, skills[0])
          yield* SessionMetadata.addRegisteredSkill(SESSION_ID, skills[1])
          return yield* SessionMetadata.getRegisteredSkills(SESSION_ID)
        }),
      )

      expect(result).toHaveLength(2)
      expect(result.map((s) => s.name).sort()).toEqual(["x", "y"])
    })

    test("returns empty array when no skills registered", async () => {
      const result = await run(SessionMetadata.getRegisteredSkills(SESSION_ID))
      expect(result).toEqual([])
    })
  })

  describe("clearMetadata", () => {
    test("clears all dynamic skills metadata", async () => {
      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo1/.agents")
          yield* SessionMetadata.addRegisteredSkill(SESSION_ID, {
            name: "test",
            description: "Test",
            location: "/test/SKILL.md",
            content: "# Test",
          })
          yield* SessionMetadata.clearMetadata(SESSION_ID)
          return yield* SessionMetadata.getMetadata(SESSION_ID)
        }),
      )

      expect(result.dynamicSkillsScanned.size).toBe(0)
      expect(Object.keys(result.dynamicSkillsRegistered)).toHaveLength(0)
    })
  })

  describe("integration: deduplication flow", () => {
    test("scanner deduplication: skip already-scanned directory", async () => {
      const result = await run(
        Effect.gen(function* () {
          // First scan: mark directory as scanned
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo1/.agents")

          // Second attempt: check if already scanned
          const alreadyScanned = yield* SessionMetadata.wasDirectoryScanned(SESSION_ID, "/repo1/.agents")

          return { alreadyScanned }
        }),
      )

      expect(result.alreadyScanned).toBe(true)
    })

    test("full flow: scan → register → restore", async () => {
      const skill: Skill.Info = {
        name: "restored-skill",
        description: "Restored",
        location: "/repo/.agents/skills/restored/SKILL.md",
        content: "# Restored",
      }

      const result = await run(
        Effect.gen(function* () {
          // Simulate scan
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo/.agents")
          yield* SessionMetadata.addRegisteredSkill(SESSION_ID, skill)

          // Simulate post-compaction restore: read skills from metadata
          const registered = yield* SessionMetadata.getRegisteredSkills(SESSION_ID)

          return {
            directoryScanned: yield* SessionMetadata.wasDirectoryScanned(SESSION_ID, "/repo/.agents"),
            registeredSkills: registered,
          }
        }),
      )

      expect(result.directoryScanned).toBe(true)
      expect(result.registeredSkills).toHaveLength(1)
      expect(result.registeredSkills[0].name).toBe("restored-skill")
    })
  })

  describe("integration: metadata survives storage round-trip", () => {
    test("metadata persists and can be reloaded after compaction", async () => {
      const skill: Skill.Info = {
        name: "persistent-skill",
        description: "Persistent",
        location: "/persist/SKILL.md",
        content: "# Persistent",
      }

      // Phase 1: Write metadata (during session)
      const writeResult = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addScannedDirectory(SESSION_ID, "/repo/.agents")
          yield* SessionMetadata.addRegisteredSkill(SESSION_ID, skill)
          return yield* SessionMetadata.getMetadata(SESSION_ID)
        }),
      )

      expect(writeResult.dynamicSkillsScanned.size).toBe(1)
      expect(writeResult.dynamicSkillsRegistered["persistent-skill"]).toBeDefined()

      // Phase 2: Simulate reload after compaction (new process reads from storage)
      const encoded = SessionMetadata.encodeMetadata(writeResult)
      const readResult = await run(
        SessionMetadata.getMetadata(SESSION_ID),
        [[["session_dynamic_skills", SESSION_ID], encoded]],
      )

      expect(readResult.dynamicSkillsScanned.size).toBe(1)
      expect(readResult.dynamicSkillsScanned.has("/repo/.agents")).toBe(true)
      expect(readResult.dynamicSkillsRegistered["persistent-skill"].name).toBe("persistent-skill")
    })
  })

  describe("injectedSkills", () => {
    test("wasSkillInjected returns false for unseen skills", async () => {
      const result = await run(SessionMetadata.wasSkillInjected(SESSION_ID, "unknown-skill"))
      expect(result).toBe(false)
    })

    test("addInjectedSkill + wasSkillInjected returns true after add", async () => {
      const result = await run(
        Effect.gen(function* () {
          yield* SessionMetadata.addInjectedSkill(SESSION_ID, "my-skill")
          return yield* SessionMetadata.wasSkillInjected(SESSION_ID, "my-skill")
        }),
      )
      expect(result).toBe(true)
    })

    test("decode backward compatibility — missing injectedSkills decodes to empty", () => {
      // Simulate old storage data without injectedSkills field
      const oldData = {
        dynamicSkillsScanned: ["/repo/.agents"],
        dynamicSkillsRegistered: {},
      }

      const decoded = SessionMetadata.decodeMetadata(oldData as any)
      expect(decoded.injectedSkills).toBeInstanceOf(Set)
      expect(decoded.injectedSkills.size).toBe(0)
    })
  })
})

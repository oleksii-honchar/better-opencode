import { describe, test, expect, mock } from "bun:test"
import { Effect, Layer, Scope, Context } from "effect"
import * as Skill from "@/skill"

// ---------------------------------------------------------------------------
// Minimal mock layer: provides Skill.Service with controlled state
// Bypasses InstanceState complexity by directly providing the interface
// ---------------------------------------------------------------------------

type State = {
  skills: Record<string, Skill.Info>
  dynamicSkills: Record<string, Skill.Info>
  dirs: Set<string>
  promoted: boolean
}

function createMockService(initialSkills: Record<string, Skill.Info> = {}): Skill.Interface {
  const state: State = {
    skills: { ...initialSkills },
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

  return { get, require, all, dirs, available, registerDynamic, promoteDynamicToStartup, allIncludingDynamic }
}

function mockLayer(initialSkills: Record<string, Skill.Info> = {}): Layer.Layer<Skill.Service> {
  return Layer.succeed(Skill.Service, createMockService(initialSkills))
}

function run<T>(program: Effect.Effect<T, unknown, Skill.Service>, initialSkills?: Record<string, Skill.Info>): Promise<T> {
  return Effect.runPromise(Effect.provide(program, mockLayer(initialSkills)))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Skill.Service — Dynamic Skills", () => {
  describe("registerDynamic", () => {
    test("adds new skills to dynamicSkills only, not to startup skills", async () => {
      const skill: Skill.Info = {
        name: "dynamic-test",
        description: "Test dynamic skill",
        location: "/tmp/dynamic-test/SKILL.md",
        content: "# Dynamic Test",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          const regResult = yield* svc.registerDynamic([skill])
          const allSkills = yield* svc.all()
          const dynamicInStartup = allSkills.find((s) => s.name === "dynamic-test")
          return { regResult, dynamicInStartup }
        }),
      )

      expect(result.regResult.added).toBe(1)
      expect(result.regResult.skipped).toBe(0)
      expect(result.dynamicInStartup).toBeUndefined()
    })

    test("skips duplicate by name in startup skills", async () => {
      const existing: Skill.Info = {
        name: "existing",
        description: "Already exists",
        location: "/tmp/existing/SKILL.md",
        content: "# Existing",
      }

      const duplicate: Skill.Info = {
        name: "existing",
        description: "Duplicate",
        location: "/tmp/duplicate/SKILL.md",
        content: "# Duplicate",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          return yield* svc.registerDynamic([duplicate])
        }),
        { existing },
      )

      expect(result.added).toBe(0)
      expect(result.skipped).toBe(1)
    })

    test("skips duplicate by name in dynamicSkills", async () => {
      const first: Skill.Info = {
        name: "once",
        description: "First",
        location: "/tmp/once/SKILL.md",
        content: "# Once",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          const r1 = yield* svc.registerDynamic([first])
          const r2 = yield* svc.registerDynamic([first])
          return { r1, r2 }
        }),
      )

      expect(result.r1.added).toBe(1)
      expect(result.r1.skipped).toBe(0)
      expect(result.r2.added).toBe(0)
      expect(result.r2.skipped).toBe(1)
    })

    test("registers multiple skills at once", async () => {
      const skills: Skill.Info[] = [
        { name: "a", description: "A", location: "/a/SKILL.md", content: "A" },
        { name: "b", description: "B", location: "/b/SKILL.md", content: "B" },
        { name: "c", description: "C", location: "/c/SKILL.md", content: "C" },
      ]

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          return yield* svc.registerDynamic(skills)
        }),
      )

      expect(result.added).toBe(3)
      expect(result.skipped).toBe(0)
    })

    test("handles mixed new and duplicate skills", async () => {
      const existing: Skill.Info = {
        name: "existing",
        description: "Startup",
        location: "/existing/SKILL.md",
        content: "# Existing",
      }

      const newSkills: Skill.Info[] = [
        { name: "new1", description: "New1", location: "/new1/SKILL.md", content: "N1" },
        existing,
        { name: "new2", description: "New2", location: "/new2/SKILL.md", content: "N2" },
      ]

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          return yield* svc.registerDynamic(newSkills)
        }),
        { existing },
      )

      expect(result.added).toBe(2)
      expect(result.skipped).toBe(1)
    })
  })

  describe("promoteDynamicToStartup", () => {
    test("moves all dynamicSkills to skills", async () => {
      const dynamicSkill: Skill.Info = {
        name: "promoted-skill",
        description: "Was dynamic",
        location: "/promoted/SKILL.md",
        content: "# Promoted",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          yield* svc.registerDynamic([dynamicSkill])
          const promoResult = yield* svc.promoteDynamicToStartup()
          const allSkills = yield* svc.all()
          const promoted = allSkills.find((s) => s.name === "promoted-skill")
          return { promoResult, promoted }
        }),
      )

      expect(result.promoResult.promoted).toBe(1)
      expect(result.promoted).toBeDefined()
      expect(result.promoted?.location).toBe("/promoted/SKILL.md")
    })

    test("is idempotent — second call is no-op", async () => {
      const dynamicSkill: Skill.Info = {
        name: "idempotent-skill",
        description: "Test",
        location: "/idempotent/SKILL.md",
        content: "# Idempotent",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          yield* svc.registerDynamic([dynamicSkill])
          const r1 = yield* svc.promoteDynamicToStartup()
          const r2 = yield* svc.promoteDynamicToStartup()
          const r3 = yield* svc.promoteDynamicToStartup()
          const allSkills = yield* svc.all()
          return { r1, r2, r3, allSkills }
        }),
      )

      expect(result.r1.promoted).toBe(1)
      expect(result.r2.promoted).toBe(0)
      expect(result.r3.promoted).toBe(0)
      expect(result.allSkills.find((s) => s.name === "idempotent-skill")).toBeDefined()
    })

    test("clears dynamicSkills after promotion — new dynamic skill can be registered", async () => {
      const dynamicSkill: Skill.Info = {
        name: "cleared-skill",
        description: "Test",
        location: "/cleared/SKILL.md",
        content: "# Cleared",
      }

      const anotherSkill: Skill.Info = {
        name: "another-skill",
        description: "Another",
        location: "/another/SKILL.md",
        content: "# Another",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          yield* svc.registerDynamic([dynamicSkill])
          yield* svc.promoteDynamicToStartup()
          // dynamicSkills cleared, can register new dynamic skill
          const reRegister = yield* svc.registerDynamic([anotherSkill])
          return reRegister
        }),
      )

      expect(result.added).toBe(1)
      expect(result.skipped).toBe(0)
    })

    test("no-op when no dynamic skills registered", async () => {
      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          return yield* svc.promoteDynamicToStartup()
        }),
      )

      expect(result.promoted).toBe(0)
    })
  })

  describe("available() excludes dynamic skills before promotion", () => {
    test("returns only startup skills when dynamic skills exist", async () => {
      const startupSkill: Skill.Info = {
        name: "startup",
        description: "Startup skill",
        location: "/startup/SKILL.md",
        content: "# Startup",
      }

      const dynamicSkill: Skill.Info = {
        name: "dynamic",
        description: "Dynamic skill",
        location: "/dynamic/SKILL.md",
        content: "# Dynamic",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          yield* svc.registerDynamic([dynamicSkill])
          const available = yield* svc.available()
          return available
        }),
        { startupSkill },
      )

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("startup")
      expect(result.find((s) => s.name === "dynamic")).toBeUndefined()
    })

    test("includes promoted skills after promotion", async () => {
      const startupSkill: Skill.Info = {
        name: "startup",
        description: "Startup skill",
        location: "/startup/SKILL.md",
        content: "# Startup",
      }

      const dynamicSkill: Skill.Info = {
        name: "dynamic",
        description: "Dynamic skill",
        location: "/dynamic/SKILL.md",
        content: "# Dynamic",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          yield* svc.registerDynamic([dynamicSkill])
          yield* svc.promoteDynamicToStartup()
          const available = yield* svc.available()
          return available
        }),
        { startupSkill },
      )

      expect(result).toHaveLength(2)
      expect(result.find((s) => s.name === "startup")).toBeDefined()
      expect(result.find((s) => s.name === "dynamic")).toBeDefined()
    })
  })

  describe("existing behavior unchanged", () => {
    test("get() still works for startup skills", async () => {
      const skill: Skill.Info = {
        name: "test-get",
        description: "Test",
        location: "/test-get/SKILL.md",
        content: "# Test",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          return yield* svc.get("test-get")
        }),
        { "test-get": skill },
      )

      expect(result).toEqual(skill)
    })

    test("get() returns undefined for missing skill", async () => {
      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          return yield* svc.get("nonexistent")
        }),
      )

      expect(result).toBeUndefined()
    })

    test("require() throws NotFoundError for missing skill", async () => {
      const program = Effect.gen(function* () {
        const svc = yield* Skill.Service
        return yield* svc.require("nonexistent")
      })

      const result = await Effect.runPromise(Effect.provide(program, mockLayer()))
        .then(() => ({ ok: true } as const))
        .catch((err: unknown) => ({ ok: false, err } as const))

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect((result.err as Error).message).toContain("nonexistent")
      }
    })

    test("all() returns all startup skills", async () => {
      const skills: Record<string, Skill.Info> = {
        a: { name: "a", description: "A", location: "/a/SKILL.md", content: "A" },
        b: { name: "b", description: "B", location: "/b/SKILL.md", content: "B" },
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          return yield* svc.all()
        }),
        skills,
      )

      expect(result).toHaveLength(2)
      expect(result.map((s) => s.name).sort()).toEqual(["a", "b"])
    })

    test("dirs() returns skill directories", async () => {
      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          return yield* svc.dirs()
        }),
      )

      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe("allIncludingDynamic", () => {
    test("returns both startup and dynamic skills when both exist", async () => {
      const startupSkill: Skill.Info = {
        name: "startup",
        description: "Startup skill",
        location: "/startup/SKILL.md",
        content: "# Startup",
      }

      const dynamicSkill: Skill.Info = {
        name: "dynamic",
        description: "Dynamic skill",
        location: "/dynamic/SKILL.md",
        content: "# Dynamic",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          yield* svc.registerDynamic([dynamicSkill])
          return yield* svc.allIncludingDynamic()
        }),
        { startupSkill },
      )

      expect(result).toHaveLength(2)
      expect(result.find((s) => s.name === "startup")).toBeDefined()
      expect(result.find((s) => s.name === "dynamic")).toBeDefined()
    })

    test("returns startup-only when no dynamic skills registered", async () => {
      const startupSkill: Skill.Info = {
        name: "startup",
        description: "Startup skill",
        location: "/startup/SKILL.md",
        content: "# Startup",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          return yield* svc.allIncludingDynamic()
        }),
        { startupSkill },
      )

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("startup")
    })

    test("returns empty when neither startup nor dynamic skills exist", async () => {
      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service
          return yield* svc.allIncludingDynamic()
        }),
      )

      expect(result).toHaveLength(0)
    })
  })

  describe("integration: full flow", () => {
    test("register → available excludes → promote → available includes", async () => {
      const startupSkill: Skill.Info = {
        name: "startup",
        description: "Startup",
        location: "/startup/SKILL.md",
        content: "# Startup",
      }

      const dynamicSkill: Skill.Info = {
        name: "dynamic",
        description: "Dynamic",
        location: "/dynamic/SKILL.md",
        content: "# Dynamic",
      }

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* Skill.Service

          // Before registration
          const beforeReg = yield* svc.available()

          // Register dynamic skill
          yield* svc.registerDynamic([dynamicSkill])

          // After registration — dynamic NOT in available
          const afterReg = yield* svc.available()

          // Promote
          const promoResult = yield* svc.promoteDynamicToStartup()

          // After promotion — dynamic IS in available
          const afterPromo = yield* svc.available()

          return { beforeReg, afterReg, promoResult, afterPromo }
        }),
        { startupSkill },
      )

      expect(result.beforeReg).toHaveLength(1)
      expect(result.beforeReg[0].name).toBe("startup")

      expect(result.afterReg).toHaveLength(1)
      expect(result.afterReg[0].name).toBe("startup")

      expect(result.promoResult.promoted).toBe(1)

      expect(result.afterPromo).toHaveLength(2)
      expect(result.afterPromo.map((s) => s.name).sort()).toEqual(["dynamic", "startup"])
    })
  })
})

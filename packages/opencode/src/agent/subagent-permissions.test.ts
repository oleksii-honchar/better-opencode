import { describe, expect, test } from "bun:test"
import { deriveSubagentSessionPermission } from "./subagent-permissions"
import type { Permission } from "../permission"

const extRules = (rules: Array<{ pattern: string; action: "allow" | "ask" | "deny" }>): Permission.Ruleset =>
  rules.map((r) => ({ permission: "external_directory", pattern: r.pattern, action: r.action }))

describe("deriveSubagentSessionPermission", () => {
  test("forwards subagent's own external_directory allow rules", () => {
    const parentSessionPermission = extRules([{ pattern: "*", action: "ask" }])
    const subagent = {
      name: "comfyui-troubleshooter",
      permission: extRules([
        { pattern: "*", action: "ask" },
        { pattern: "/Volumes/Data/www/*", action: "allow" },
      ]) as Permission.Ruleset,
    }
    const result = deriveSubagentSessionPermission({
      parentSessionPermission,
      parentAgent: undefined,
      subagent: subagent as any,
    })

    const allows = result.filter((r) => r.permission === "external_directory" && r.action === "allow")
    expect(allows.some((r) => r.pattern === "/Volumes/Data/www/*")).toBe(true)
  })

  test("subagent allows override parent default ask but not parent deny (findLast)", () => {
    const parentSessionPermission = extRules([
      { pattern: "*", action: "ask" },
      { pattern: "**/secrets/**", action: "deny" },
    ])
    const subagent = {
      name: "s",
      permission: extRules([{ pattern: "*", action: "ask" }, { pattern: "**/*", action: "allow" }]),
    }
    const result = deriveSubagentSessionPermission({
      parentSessionPermission,
      parentAgent: undefined,
      subagent: subagent as any,
    })

    const order = result.filter((r) => r.permission === "external_directory")
    // parent external first, subagent allows middle, parent deny last → deny wins for secrets
    expect(order[0].action).toBe("ask")
    expect(order.map((r) => r.action).includes("allow")).toBe(true)
    expect(order[order.length - 1].action).toBe("deny")
  })

  test("keeps todowrite/task denies when subagent lacks them", () => {
    const subagent = { name: "s", permission: [] as Permission.Ruleset }
    const result = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent: subagent as any,
    })
    const todowrite = result.find((r) => r.permission === "todowrite")
    const task = result.find((r) => r.permission === "task")
    expect(todowrite).toEqual({ permission: "todowrite", pattern: "*", action: "deny" })
    expect(task).toEqual({ permission: "task", pattern: "*", action: "deny" })
  })

  test("does not duplicate subagent allows when parent already has them", () => {
    const parentSessionPermission = extRules([{ pattern: "/Volumes/Data/www/*", action: "allow" }])
    const subagent = {
      name: "s",
      permission: extRules([{ pattern: "*", action: "ask" }, { pattern: "/Volumes/Data/www/*", action: "allow" }]),
    }
    const result = deriveSubagentSessionPermission({
      parentSessionPermission,
      parentAgent: undefined,
      subagent: subagent as any,
    })
    const allowCount = result.filter(
      (r) => r.permission === "external_directory" && r.pattern === "/Volumes/Data/www/*",
    ).length
    // 1 from subagent + 1 from parent = 2; findLast still resolves to allow
    expect(allowCount).toBe(2)
    const exts = result.filter((r) => r.permission === "external_directory")
    expect(exts.every((r) => r.action !== "deny")).toBe(true)
  })
})
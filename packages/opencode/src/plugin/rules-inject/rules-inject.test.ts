import { describe, expect, test } from "bun:test"
import os from "os"
import fs from "fs"
import path from "path"
import { RulesInjectPlugin, loadRules, resetForTesting } from "./index"
import { mergeConfig } from "./config"

describe("loadRules", () => {
  test("expands ~ to os.homedir()", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    const sub = path.join(tmp, "rules")
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, "a.mdc"), "rule-a\n")

    const folder = "~/" + path.relative(os.homedir(), sub)
    const result = await loadRules(folder)
    expect(result).toContain("rule-a")

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("loads only *.mdc files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    fs.writeFileSync(path.join(tmp, "a.mdc"), "a-content\n")
    fs.writeFileSync(path.join(tmp, "b.md"), "b-content\n")
    fs.writeFileSync(path.join(tmp, "c.txt"), "c-content\n")
    fs.writeFileSync(path.join(tmp, "d.mdc"), "d-content\n")

    const result = await loadRules(tmp)
    expect(result).toContain("a-content")
    expect(result).toContain("d-content")
    expect(result).not.toContain("b-content")
    expect(result).not.toContain("c-content")

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("sorts files by filename", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    fs.writeFileSync(path.join(tmp, "z.mdc"), "z-content\n")
    fs.writeFileSync(path.join(tmp, "a.mdc"), "a-content\n")
    fs.writeFileSync(path.join(tmp, "m.mdc"), "m-content\n")

    const result = await loadRules(tmp)
    const aIdx = result.indexOf("a-content")
    const mIdx = result.indexOf("m-content")
    const zIdx = result.indexOf("z-content")
    expect(aIdx).toBeLessThan(mIdx)
    expect(mIdx).toBeLessThan(zIdx)

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("prefixes each file with Instructions from: <path>", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    fs.writeFileSync(path.join(tmp, "test.mdc"), "test-rule\n")

    const result = await loadRules(tmp)
    expect(result).toContain(`Instructions from: ${path.join(tmp, "test.mdc")}`)
    expect(result).toContain("test-rule")

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("joins multiple files with \\n\\n", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    fs.writeFileSync(path.join(tmp, "a.mdc"), "a\n")
    fs.writeFileSync(path.join(tmp, "b.mdc"), "b\n")

    const result = await loadRules(tmp)
    expect(result).toContain("a\n")
    expect(result).toContain("\n\n\nInstructions from:")
    expect(result).toContain("\nb\n")

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("returns empty string when folder does not exist", async () => {
    const result = await loadRules("/nonexistent-folder-" + Date.now())
    expect(result).toBe("")
  })

  test("returns empty string when folder has no .mdc files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    fs.writeFileSync(path.join(tmp, "readme.txt"), "hello\n")

    const result = await loadRules(tmp)
    expect(result).toBe("")

    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe("RulesInjectPlugin — transform hook", () => {
  const fakeModel = {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: 4096, input: 2048, output: 2048 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  } as any

  function makeTransformInput(sessionID?: string) {
    return { sessionID, model: fakeModel }
  }

  test("prepends rules + \\n\\n to system[0] when enabled with sessionID", async () => {
    resetForTesting()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    fs.writeFileSync(path.join(tmp, "always.mdc"), "ALWAYS RULE\n")

    const hooks = await RulesInjectPlugin({} as any)
    hooks.config?.({ rulesInject: { alwaysApplyFolder: tmp } } as any)

    const system = ["original system prompt"]
    await hooks["experimental.chat.system.transform"]?.(makeTransformInput("session-1"), { system })

    expect(system).toHaveLength(1)
    expect(system[0]).toBe("Instructions from: " + path.join(tmp, "always.mdc") + "\nALWAYS RULE\n\n\noriginal system prompt")

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("dedupes per sessionID — second call for same session no-ops", async () => {
    resetForTesting()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    fs.writeFileSync(path.join(tmp, "x.mdc"), "X\n")

    const hooks = await RulesInjectPlugin({} as any)
    hooks.config?.({ rulesInject: { alwaysApplyFolder: tmp } } as any)

    const system = ["base"]
    await hooks["experimental.chat.system.transform"]?.(makeTransformInput("s1"), { system })
    const afterFirst = system[0]

    await hooks["experimental.chat.system.transform"]?.(makeTransformInput("s1"), { system })
    expect(system[0]).toBe(afterFirst)

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("skips when enabled: false", async () => {
    resetForTesting()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    fs.writeFileSync(path.join(tmp, "skip.mdc"), "SHOULD-NOT-APPEAR\n")

    const hooks = await RulesInjectPlugin({} as any)
    hooks.config?.({ rulesInject: { enabled: false, alwaysApplyFolder: tmp } } as any)

    const system = ["original"]
    await hooks["experimental.chat.system.transform"]?.(makeTransformInput("session-2"), { system })

    expect(system).toEqual(["original"])

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("skips when input.sessionID is missing", async () => {
    resetForTesting()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    fs.writeFileSync(path.join(tmp, "no-session.mdc"), "NO-SESSION\n")

    const hooks = await RulesInjectPlugin({} as any)
    hooks.config?.({ rulesInject: { alwaysApplyFolder: tmp } } as any)

    const system = ["original"]
    await hooks["experimental.chat.system.transform"]?.(makeTransformInput(undefined), { system })

    expect(system).toEqual(["original"])

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("skips when folder is empty — returns without mutating system", async () => {
    resetForTesting()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))

    const hooks = await RulesInjectPlugin({} as any)
    hooks.config?.({ rulesInject: { alwaysApplyFolder: tmp } } as any)

    const system = ["original"]
    await hooks["experimental.chat.system.transform"]?.(makeTransformInput("session-3"), { system })

    expect(system).toEqual(["original"])

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("skips when folder is unreadable — returns without mutating system", async () => {
    resetForTesting()

    const hooks = await RulesInjectPlugin({} as any)
    hooks.config?.({ rulesInject: { alwaysApplyFolder: "/nonexistent-folder-" + Date.now() } } as any)

    const system = ["original"]
    await hooks["experimental.chat.system.transform"]?.(makeTransformInput("session-4"), { system })

    expect(system).toEqual(["original"])
  })

  test("leaves system untouched when output.system.length === 0", async () => {
    resetForTesting()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
    fs.writeFileSync(path.join(tmp, "empty.mdc"), "EMPTY\n")

    const hooks = await RulesInjectPlugin({} as any)
    hooks.config?.({ rulesInject: { alwaysApplyFolder: tmp } } as any)

    const system: string[] = []
    await hooks["experimental.chat.system.transform"]?.(makeTransformInput("session-5"), { system })

    expect(system).toEqual([])

    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe("RulesInjectPlugin — config hook", () => {
  test("config hook updates activeConfig via mergeConfig", async () => {
    resetForTesting()
    const hooks = await RulesInjectPlugin({} as any)

    hooks.config?.({ rulesInject: { enabled: false, alwaysApplyFolder: "~/.rules/custom" } } as any)

    const system = ["original"]
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "test", model: {} as any },
      { system },
    )
    expect(system).toEqual(["original"])

    fs.rmSync("/tmp/rules-test-config", { recursive: true, force: true })
  })
})

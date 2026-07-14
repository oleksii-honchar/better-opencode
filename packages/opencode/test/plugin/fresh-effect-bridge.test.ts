import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

const indexPath = path.join(__dirname, "../../src/plugin/index.ts")
const source = fs.readFileSync(indexPath, "utf-8")

describe("plugin.index — fresh context via Effect.context() + Effect.provide()", () => {
  test("effectWithContext acquires fresh context via Effect.context()", () => {
    const match = source.match(/const effectWithContext = Effect\.gen\(function\* \(\) \{[\s\S]*?yield\* Effect\.context\(\)/)
    if (!match) throw new Error("effectWithContext does not acquire Effect.context()")
  })

  test("collect is piped through Effect.provide(freshContext)", () => {
    const match = source.match(/collect\.pipe\(Effect\.provide\(freshContext\)\)/)
    if (!match) throw new Error("collect is not piped with Effect.provide(freshContext)")
  })

  test("bridge.promise(effectWithContext) is used for LLM calls", () => {
    const match = source.match(/return bridge\.promise\(effectWithContext\)/)
    if (!match) throw new Error("bridge.promise(effectWithContext) not found")
  })

  test("stale bridge pattern bridge.promise(collect) is NOT used", () => {
    const match = source.match(/return bridge\.promise\(collect\)/)
    if (match) throw new Error("Old stale bridge pattern bridge.promise(collect) still present")
  })

  test("old freshBridge approach is NOT used", () => {
    const match = source.match(/freshBridge\.promise\(collect\)/)
    if (match) throw new Error("Old freshBridge.promise(collect) still present — should be removed")
  })

  test("original bridge preserved for publishPluginError", () => {
    const bridgeMatch = source.match(/const bridge = yield\* EffectBridge\.make\(\)/)
    if (!bridgeMatch) throw new Error("Original bridge variable not found")

    const publishErrorMatch = source.match(/function publishPluginError\(/)
    if (!publishErrorMatch) throw new Error("publishPluginError function not found")

    const bridgeForkMatch = source.match(/bridge\.fork\(bus\.publish/)
    if (!bridgeForkMatch) throw new Error("bridge.fork(bus.publish) not found — original bridge not used for error publishing")
  })
})

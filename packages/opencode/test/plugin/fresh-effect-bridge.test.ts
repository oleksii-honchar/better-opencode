import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

const indexPath = path.join(__dirname, "../../src/plugin/index.ts")
const source = fs.readFileSync(indexPath, "utf-8")

describe("plugin.index — fresh EffectBridge at LLM call time", () => {
  test("chatCompletionWithModel creates fresh EffectBridge at LLM call time", () => {
    // The fresh bridge should be created via Effect.runPromise(EffectBridge.make())
    // at the async level — captures current context with LLM at call time.
    const freshBridgeMatch = source.match(/const freshBridge = await Effect\.runPromise\(EffectBridge\.make\(\)\)/)
    expect(freshBridgeMatch).not.toBeNull()
  })

  test("inner LLM logic runs through freshBridge.promise()", () => {
    // After creating freshBridge, the collect Effect should be run through freshBridge.promise()
    const freshBridgePromiseMatch = source.match(/freshBridge\.promise\(collect\)/)
    expect(freshBridgePromiseMatch).not.toBeNull()
  })

  test("fresh bridge used instead of stale bridge for LLM calls", () => {
    // The chatCompletionWithModel should use freshBridge.promise(collect)
    const freshBridgeUsedMatch = source.match(/freshBridge\.promise\(collect\)/)
    expect(freshBridgeUsedMatch).not.toBeNull()

    // Verify the old stale bridge pattern is NOT used for LLM calls
    const staleBridgeMatch = source.match(/return bridge\.promise\(collect\)/)
    expect(staleBridgeMatch).toBeNull()
  })

  test("fresh bridge created via await Effect.runPromise(EffectBridge.make()) at async level", () => {
    // After creating freshBridge at async level, the LLM logic should be run through freshBridge.promise()
    const freshBridgePromiseMatch = source.match(/const freshBridge = await Effect\.runPromise\(EffectBridge\.make\(\)\)[\s\S]*?freshBridge\.promise\(/)
    expect(freshBridgePromiseMatch).not.toBeNull()
  })

  test("collect runs via freshBridge.promise(collect) instead of stale bridge.promise(collect)", () => {
    // The chatCompletionWithModel should use freshBridge.promise(collect) not bridge.promise(collect)
    const freshBridgePromiseMatch = source.match(/return freshBridge\.promise\(collect\)/)
    expect(freshBridgePromiseMatch).not.toBeNull()

    // Verify the old pattern is NOT used
    const staleBridgeMatch = source.match(/return bridge\.promise\(collect\)/)
    expect(staleBridgeMatch).toBeNull()
  })

  test("original bridge preserved for publishPluginError", () => {
    // The original bridge at line 129 should still exist for publishPluginError
    const originalBridgeMatch = source.match(/const bridge = yield\* EffectBridge\.make\(\)/)
    expect(originalBridgeMatch).not.toBeNull()

    const publishErrorMatch = source.match(/function publishPluginError\(/)
    expect(publishErrorMatch).not.toBeNull()

    const bridgeForkMatch = source.match(/bridge\.fork\(bus\.publish/)
    expect(bridgeForkMatch).not.toBeNull()
  })
})

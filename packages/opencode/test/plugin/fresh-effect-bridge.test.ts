import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

const indexPath = path.join(__dirname, "../../src/plugin/index.ts")
const source = fs.readFileSync(indexPath, "utf-8")

describe("plugin.index — fix effectWithContext self-defeating pattern", () => {
  test("effectWithContext pattern is removed — bridge.promise(collect) used directly", () => {
    const effectWithContextMatch = source.match(/const effectWithContext = Effect\.gen\(/)
    if (effectWithContextMatch) throw new Error("effectWithContext still present — should be removed")

    const bridgePromiseCollectMatch = source.match(/return bridge\.promise\(collect\)/)
    if (!bridgePromiseCollectMatch) throw new Error("bridge.promise(collect) not found — should be used directly")
  })

  test("collect Effect yields LLM.Service (reads from bridge context)", () => {
    const collectMatch = source.match(/const collect = Effect\.gen\(function\* \(\) \{[\s\S]*?yield\* LLM\.Service/)
    if (!collectMatch) throw new Error("yield* LLM.Service not found inside collect Effect")
  })

  test("original bridge preserved for publishPluginError", () => {
    const bridgeMatch = source.match(/const bridge = yield\* EffectBridge\.make\(\)/)
    if (!bridgeMatch) throw new Error("Original bridge variable not found")

    const publishErrorMatch = source.match(/function publishPluginError\(/)
    if (!publishErrorMatch) throw new Error("publishPluginError function not found")

    const bridgeForkMatch = source.match(/bridge\.fork\(bus\.publish/)
    if (!bridgeForkMatch) throw new Error("bridge.fork(bus.publish) not found — original bridge not used for error publishing")
  })

  test("defaultLayer does not provide LLM — callers must compose LLM separately", () => {
    const hasLLMInDefaultLayer = source.match(/defaultLayer[\s\S]*?LLM/)
    if (hasLLMInDefaultLayer) throw new Error("LLM should not be in defaultLayer — callers compose it separately")
  })
})

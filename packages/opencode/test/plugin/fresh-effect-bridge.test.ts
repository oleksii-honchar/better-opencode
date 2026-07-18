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

  test("chatCompletionWithModel throws clear error when _cachedLLM is not set", () => {
    const errorMsg = "LLM service not yet available — Plugin.trigger must be called first"
    if (!source.includes(errorMsg)) throw new Error(`Expected error message not found: "${errorMsg}"`)
  })

  test("collect Effect no longer uses yield* LLM.Service — uses _cachedLLM via local ref", () => {
    // Pattern changed: before collect, _cachedLLM is read into local llmSrv
    if (!source.includes("const llmSrv = _cachedLLM")) {
      throw new Error("_cachedLLM should be referenced before collect Effect")
    }
    // collect Effect itself should use llmSrv.stream, not yield* LLM.Service
    const collectMatch = source.match(/const collect = Effect\.gen\(function\* \(\) \{[\s\S]*?return \{ content, usage \}\s*\}\)/)
    if (!collectMatch) throw new Error("collect Effect block not found in source")
    if (collectMatch[0].includes("yield* LLM.Service")) {
      throw new Error("yield* LLM.Service should NOT be inside collect Effect anymore")
    }
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

import { describe, expect, test } from "bun:test"
import { buildCategoryRouter } from "./category-mapper"
import { defaultInspectorConfig } from "./config.schema"
import type { SessionInspectorConfig } from "./config.schema"
import { GOLDEN_CATEGORY_IDS } from "./session-inspector.test-utils"

// Task 4 AC2/AC3 — category assignment is 100 % config-driven over the §5.6 default set.
// Fixtures mirror the §5.6 vocabulary; the same-default-config assertion below locks
// GOLDEN_CATEGORY_IDS (the world the router is built against) so this test fails loudly
// if shipped defaults ever drift.

const dirs = { agentsRoot: "/t/agents", logsDir: "/t/logs" }
const defaultConfig = (): SessionInspectorConfig => defaultInspectorConfig(dirs)

describe("category mapper — §5.6 vocabulary under shipped defaults (AC2)", () => {
  test("router built from shipped defaults sees the full golden category set", () => {
    const config = defaultConfig()
    expect(config.categories.map((c) => c.id)).toEqual([...GOLDEN_CATEGORY_IDS])
    const router = buildCategoryRouter(config)
    expect(router.catchAllId()).toBe("other")
  })

  test("part rows map by type AND role per config sources", () => {
    const router = buildCategoryRouter(defaultConfig())
    expect(router.partCategory("text", "user")).toBe("user-messages")
    expect(router.partCategory("text", "assistant")).toBe("assistant-text")
    expect(router.partCategory("reasoning", "assistant")).toBe("reasoning")
    expect(router.partCategory("tool", "assistant")).toBe("tool-calls")
    // NAMED DELTA (AD18): the step-start/step-finish pins MOVED from "maps to lifecycle"
    // to EXCLUDED-NEVER-CATEGORIZED — they are dropped at the JOIN BEFORE routing, so this
    // mapper (config parts list stays AS-IS by ruling) simply never receives them:
    // "excluded, never categorized" is pinned in timeline.test's ad18 suite (zero rows, ANY
    // config). Mapper-level silence here is the contract, not an omission.
    expect(router.partCategory("patch", null)).toBe("lifecycle")
    expect(router.partCategory("compaction", null)).toBe("lifecycle")
    expect(router.partCategory("file", null)).toBe("lifecycle")
    // a text part whose role matches no configured role set must not vanish: it lands in other
    expect(router.partCategory("text", "system")).toBe("other")
    expect(router.partCategory("text", null)).toBe("other")
  })

  test("TRN and persona.transition map to the SAME configured category (alias rule)", () => {
    const router = buildCategoryRouter(defaultConfig())
    const primary = router.historyEventCategory("persona.transition")
    const alias = router.historyEventCategory("TRN")
    expect(primary).toBe("transitions")
    expect(alias).toBe(primary)
  })

  test("base vocabulary, plugin and agent names map to their configured columns", () => {
    const router = buildCategoryRouter(defaultConfig())
    expect(router.historyEventCategory("started")).toBe("pipeline")
    expect(router.historyEventCategory("handoff")).toBe("pipeline")
    expect(router.historyEventCategory("completed")).toBe("pipeline")
    expect(router.historyEventCategory("error")).toBe("pipeline")
    expect(router.historyEventCategory("agent.coach")).toBe("coach-activity")
    expect(router.historyEventCategory("agent.amt")).toBe("amt-activity")
    expect(router.historyEventCategory("plugin.nudge")).toBe("engine-nudges")
    // judge lane renders via legacy auto-detect; the plugin.judge name still maps to its column
    expect(router.historyEventCategory("plugin.judge")).toBe("coach-judge")
  })

  test("unknown event names and unknown part types land in other, never vanish (two separate arms)", () => {
    const router = buildCategoryRouter(defaultConfig())
    expect(router.historyEventCategory("some.future_event")).toBe("other")
    expect(router.partCategory("quantum-flux", null)).toBe("other")
  })

  test("assignment follows config, not hardcoded names: remapping 'started' moves it to a custom column", () => {
    const config = defaultConfig()
    const custom: SessionInspectorConfig = {
      ...config,
      categories: [
        ...config.categories,
        {
          id: "my-col",
          title: "My Column",
          order: 13,
          sources: { historyEvents: ["started"] },
          enabled: true,
        },
      ],
    }
    const router = buildCategoryRouter(custom)
    // my-col is ordered 13 (after pipeline's 6); first-match wins → "started" keeps pipeline.
    expect(router.historyEventCategory("started")).toBe("pipeline")

    const customOnly: SessionInspectorConfig = {
      ...config,
      categories: [
        { id: "my-col", title: "My Column", order: 1, sources: { historyEvents: ["started"] }, enabled: true },
        ...config.categories.filter((c) => c.id !== "pipeline"),
      ],
    }
    expect(buildCategoryRouter(customOnly).historyEventCategory("started")).toBe("my-col")
  })

  test("synthetic-ness is NOT part of mapper matching — the §5.6 col-10 fallback is JOIN behavior (Task 4b guard)", () => {
    // The mapper only ever sees (data.type, message.role). If anyone later pushes the
    // synthetic-fallback decision into the router, this guard flips: synthetic text parts
    // keep their ordinary role mapping at mapper level; the join adds the nudges-column
    // fallback with attributed:false and ref_part_id suppression.
    const router = buildCategoryRouter(defaultConfig())
    expect(router.partCategory("text", "user")).toBe("user-messages")
    expect(router.partCategory("text", "assistant")).toBe("assistant-text")
    expect(router.historyEventCategory("plugin.nudge")).toBe("engine-nudges") // source lane owner
  })

  test("part type configured in two columns resolves to the lowest order (deterministic first match)", () => {
    const config = defaultConfig()
    const conflicted: SessionInspectorConfig = {
      ...config,
      categories: config.categories.map((c) =>
        c.id === "reasoning" ? { ...c, order: 0, sources: { parts: ["tool"] } } : c,
      ),
    }
    const router = buildCategoryRouter(conflicted)
    expect(router.partCategory("tool", "assistant")).toBe("reasoning")
  })
})


// ---------------------------------------------------------------------------
// AD38 (R1) — owner order 2026-11-07 after AD37 answered "what remains in Other":
// "gate-blocked should go to 'Coach Activity'". Pure DEFAULTS routing: the lane set
// and every other mapping stay byte-identical; the router reads config, so the ONLY
// code change lives in config.schema.ts defaultCategories(). Defaults (not owner
// file) because the owner file carries no categories section — adding one there
// would force full 12-category array replacement (rejected; DEC-O).
describe("ad38 defaults — gate-blocked is coach-owned noise", () => {
  test("shipped defaults list gate-blocked in coach-activity sources (order = declaration order)", () => {
    const config = defaultConfig()
    const coach = config.categories.find((c) => c.id === "coach-activity")
    // v14 (Design v1 traceability): nudge-delivered receipts joined this lane — still
    // declaration order, still NOTHING else moved (the neighbor pins below hold unchanged).
    expect(coach?.sources.historyEvents).toEqual(["agent.coach", "gate-blocked", "nudge-delivered"])
  })
  test("router routes gate-blocked to coach-activity; NOTHING else moves (neighbor pins + catch-all + part arm)", () => {
    const router = buildCategoryRouter(defaultConfig())
    expect(router.historyEventCategory("gate-blocked")).toBe("coach-activity")
    // neighbor lanes byte-identical:
    expect(router.historyEventCategory("agent.coach")).toBe("coach-activity")
    expect(router.historyEventCategory("agent.amt")).toBe("amt-activity")
    expect(router.historyEventCategory("plugin.nudge")).toBe("engine-nudges")
    expect(router.historyEventCategory("started")).toBe("pipeline")
    // catch-all still catches what config does not name:
    expect(router.historyEventCategory("some.future_event")).toBe("other")
    expect(router.partCategory("quantum-flux", null)).toBe("other")
  })
})

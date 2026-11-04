import z from "zod"

// Session Inspector configuration (§5.1-3, §5.6, DEC-I).
// Built-in defaults are the §5.6 default category set shipped in code; the user override file
// (~/.config/opencode/session-inspector.json, path overridable) is validated here, hard-fail.
// Merge semantics are SECTION-REPLACEMENT (documented task-2 choice): a present section in the
// user file replaces its default wholesale; an absent section keeps the built-in default.
// No deep per-field merging — deterministic and explainable for a debug surface.

export const SESSION_INSPECTOR_CONFIG_VERSION = 1

const CategorySourceSchema = z
  .object({
    parts: z.array(z.string().min(1)).optional(),
    roles: z.array(z.string().min(1)).optional(),
    historyEvents: z.array(z.string().min(1)).optional(),
    log: z.string().min(1).optional(),
  })
  .strict()

const CategorySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
    title: z.string().min(1),
    order: z.number().int().positive(),
    sources: CategorySourceSchema,
    catchAll: z.boolean().optional(),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((category, ctx) => {
    const sourced =
      category.sources.parts !== undefined ||
      category.sources.historyEvents !== undefined ||
      category.sources.log !== undefined ||
      category.catchAll === true
    if (!sourced) {
      ctx.addIssue({
        code: "custom",
        message:
          'category must define at least one of sources.parts / sources.historyEvents / sources.log, or "catchAll": true',
        path: ["sources"],
      })
    }
  })

const CategoriesListSchema = z.array(CategorySchema).superRefine((categories, ctx) => {
  const seen = new Set<string>()
  for (const [index, category] of categories.entries()) {
    if (seen.has(category.id)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate category id "${category.id}"`,
        path: ["categories", index, "id"],
      })
    }
    seen.add(category.id)
  }
})

const CellSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict()

const PathsSchema = z
  .object({
    // "engine-derived" = mirror storage/db.ts precedence; any other string is an explicit
    // DB file path selected by the owner (DEC-E: explicit selection only, never a merge).
    dbMode: z.union([z.literal("engine-derived"), z.string().min(1)]),
    agentsRoot: z.string().min(1),
    logsDir: z.string().min(1),
  })
  .strict()

const LimitsSchema = z
  .object({
    payloadCapBytes: z.number().int().positive(),
    toolsLogEnrichment: z.boolean(),
    historyTailBytes: z.number().int().positive(),
  })
  .strict()

// Emission gates (spec §8: every plugin.nudge attribution default-OFF; enablement is P5).
// Never read point-of-use from process.env — the engine emitter consumes this flag
// through loadInspectorConfig (session-inspector config surface).
const EmittersSchema = z.object({ pluginNudgeHistory: z.boolean() }).strict()

/** The fully-merged effective config (what GET /session-inspector/config returns). */
export const SessionInspectorConfigSchema = z
  .object({
    version: z.literal(SESSION_INSPECTOR_CONFIG_VERSION),
    categories: CategoriesListSchema,
    cell: CellSchema,
    paths: PathsSchema,
    limits: LimitsSchema,
    emitters: EmittersSchema,
  })
  .strict()
export type SessionInspectorConfig = z.infer<typeof SessionInspectorConfigSchema>
export type InspectorCategory = SessionInspectorConfig["categories"][number]

/** User override file grammar: every section optional (absent → defaults) but complete when present. */
export const InspectorUserConfigFileSchema = z
  .object({
    version: z.literal(SESSION_INSPECTOR_CONFIG_VERSION).optional(),
    categories: CategoriesListSchema.optional(),
    cell: CellSchema.optional(),
    paths: PathsSchema.optional(),
    limits: LimitsSchema.optional(),
    emitters: EmittersSchema.optional(),
  })
  .strict()
export type InspectorUserConfigFile = z.infer<typeof InspectorUserConfigFileSchema>

const category = (
  order: number,
  id: string,
  title: string,
  sources: InspectorCategory["sources"],
  extra: Pick<InspectorCategory, "catchAll"> = {},
): InspectorCategory => ({ id, title, order, sources, enabled: true, ...extra })

/** The §5.6 default column set, in top→left order — task 10 re-checks; task 4 consumes. */
export function defaultCategories(): InspectorCategory[] {
  return [
    category(1, "user-messages", "User Messages", { parts: ["text"], roles: ["user"] }),
    category(2, "assistant-text", "Assistant Text", { parts: ["text"], roles: ["assistant"] }),
    category(3, "reasoning", "Reasoning", { parts: ["reasoning"] }),
    category(4, "tool-calls", "Tool Calls", { parts: ["tool"], log: "tools.log" }),
    category(5, "transitions", "Transitions", { historyEvents: ["persona.transition", "TRN"] }),
    category(6, "pipeline", "Pipeline", { historyEvents: ["started", "handoff", "completed", "error"] }),
    category(7, "coach-judge", "Coach Judge", { historyEvents: ["plugin.judge"] }),
    category(8, "coach-activity", "Coach Activity", { historyEvents: ["agent.coach"] }),
    category(9, "amt-activity", "AMT Activity", { historyEvents: ["agent.amt"] }),
    category(10, "engine-nudges", "Engine Nudges", { historyEvents: ["plugin.nudge"] }),
    category(11, "lifecycle", "Lifecycle", { parts: ["step-start", "step-finish", "patch", "compaction", "file"] }),
    category(12, "other", "Other", {}, { catchAll: true }),
  ]
}

export interface SessionInspectorDefaultDirs {
  agentsRoot: string
  logsDir: string
}

// Cell defaults: reasonable fixed cell grid (no spec-pinned numbers; §5.6 defers to config).
// Task 10 re-checks the final default set with the owner.
export function defaultInspectorConfig(dirs: SessionInspectorDefaultDirs): SessionInspectorConfig {
  return {
    version: SESSION_INSPECTOR_CONFIG_VERSION,
    categories: defaultCategories(),
    cell: { width: 360, height: 120 },
    paths: { dbMode: "engine-derived", agentsRoot: dirs.agentsRoot, logsDir: dirs.logsDir },
    limits: { payloadCapBytes: 262144, toolsLogEnrichment: true, historyTailBytes: 4194304 },
    emitters: { pluginNudgeHistory: false },
  }
}

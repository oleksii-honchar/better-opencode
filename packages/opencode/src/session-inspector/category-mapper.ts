import type { InspectorCategory, SessionInspectorConfig } from "./config.schema"

// Category assignment for the timeline join (spec §5.6, DEC-I): 100 % config-driven.
// No event names or part types are hardcoded here — the shipped §5.6 vocabulary lives
// ONLY in config.schema defaults; this module interprets whatever the effective config
// declares. Unknown names fall to the configured catch-all ("other" by default) so
// future vocabulary degrades visibly, never vanishes (DEC-I).

export interface CategoryRouter {
  /** Category id for a DB part row given its data.type and message role (null when unknown). */
  partCategory: (partType: string, role: string | null) => string
  /** Category id for a history.jsonl `event` name (incl. configured aliases like "TRN"). */
  historyEventCategory: (eventName: string) => string
  /** The configured catch-all column id. */
  catchAllId: () => string
}

export function buildCategoryRouter(config: SessionInspectorConfig): CategoryRouter {
  const ordered = [...config.categories].sort((a, b) => a.order - b.order)
  const catchAll = ordered.find((category) => category.catchAll === true)

  const catchAllIdValue = catchAll?.id ?? "other"

  // First match in configured order wins (deterministic when sources overlap).
  const match = (predicate: (category: InspectorCategory) => boolean): string | undefined =>
    ordered.find((category) => !category.catchAll && predicate(category))?.id

  const matchesParts = (category: InspectorCategory, partType: string, role: string | null): boolean => {
    const sources = category.sources
    if (sources.parts === undefined || !sources.parts.includes(partType)) return false
    if (sources.roles === undefined) return true
    return role !== null && sources.roles.includes(role)
  }

  return {
    partCategory: (partType, role) =>
      match((category) => matchesParts(category, partType, role)) ?? catchAllIdValue,
    historyEventCategory: (eventName) =>
      match((category) => category.sources.historyEvents?.includes(eventName) === true) ?? catchAllIdValue,
    catchAllId: () => catchAllIdValue,
  }
}

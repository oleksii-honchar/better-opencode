export interface RulesInjectConfig {
  enabled: boolean
  alwaysApplyFolder: string
  position: "before" | "after-persona"
}

export const defaultConfig: RulesInjectConfig = {
  enabled: true,
  alwaysApplyFolder: "~/.rules/always-apply",
  position: "after-persona",
}

export function mergeConfig(partial: Partial<RulesInjectConfig>): RulesInjectConfig {
  return { ...defaultConfig, ...partial }
}

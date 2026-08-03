export interface RulesInjectConfig {
  enabled: boolean
  alwaysApplyFolder: string
}

export const defaultConfig: RulesInjectConfig = {
  enabled: true,
  alwaysApplyFolder: "~/.rules/always-apply",
}

export function mergeConfig(partial: Partial<RulesInjectConfig>): RulesInjectConfig {
  return { ...defaultConfig, ...partial }
}

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import fs from "fs"
import os from "os"
import path from "path"
import { defaultConfig, mergeConfig } from "./config"

const log = Log.create({ service: "plugin.rules-inject" })

let activeConfig = defaultConfig
const injected = new Set<string>()

export function resetForTesting(): void {
  activeConfig = defaultConfig
  injected.clear()
}

export async function loadRules(folder: string): Promise<string> {
  const expanded = folder.replace(/^~/, os.homedir())

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(expanded, { withFileTypes: true })
  } catch (err) {
    log.warn("Failed to read rules folder", { folder: expanded, error: err })
    return ""
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".mdc"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => path.join(expanded, e.name))

  if (files.length === 0) {
    return ""
  }

  const parts: string[] = []
  for (const file of files) {
    let content: string
    try {
      content = fs.readFileSync(file, "utf-8")
    } catch (err) {
      log.warn("Failed to read rule file", { file, error: err })
      continue
    }
    parts.push(`Instructions from: ${file}\n${content}`)
  }

  return parts.join("\n\n")
}

export async function RulesInjectPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    config: async (cfg) => {
      const partial = (cfg as { rulesInject?: { enabled?: boolean; alwaysApplyFolder?: string } }).rulesInject ?? {}
      activeConfig = mergeConfig(partial)
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!activeConfig.enabled) {
        return
      }

      if (!input.sessionID) {
        return
      }

      if (injected.has(input.sessionID)) {
        return
      }

      const rules = await loadRules(activeConfig.alwaysApplyFolder)
      if (!rules) {
        return
      }

      if (output.system.length === 0) {
        return
      }

      output.system[0] = rules + "\n\n" + output.system[0]
      injected.add(input.sessionID)
    },
  }
}

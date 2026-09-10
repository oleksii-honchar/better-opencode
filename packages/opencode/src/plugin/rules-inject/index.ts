import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import fs from "fs"
import os from "os"
import path from "path"
import { defaultConfig, mergeConfig } from "./config"

const log = Log.create({ service: "plugin.rules-inject" })

let activeConfig = defaultConfig
const injected = new Set<string>()

// Load user-defined agent names from the agents directory
const AGENTS_DIR = path.join(os.homedir(), ".config/opencode/agents")
const userAgents = new Set<string>()

function loadUserAgents(): void {
  try {
    const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const agentName = entry.name.slice(0, -3)
        userAgents.add(agentName)
      }
    }
    log.info("loaded user agents from agents directory", {
      agentsDir: AGENTS_DIR,
      agentCount: userAgents.size,
      agents: [...userAgents],
    })
  } catch (err) {
    log.warn("failed to load user agents from agents directory", {
      agentsDir: AGENTS_DIR,
      error: err,
    })
  }
}

loadUserAgents()

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
    log.warn("loadRules: Failed to read rules folder", { folder: expanded, error: err })
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
      log.warn("loadRules: Failed to read rule file", { file, error: err })
      continue
    }
    parts.push(`Instructions from: ${file}\n${content}`)
  }

  return parts.join("\n\n")
}

export async function RulesInjectPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    config: async (cfg) => {
      const partial =
        (
          cfg as {
            rulesInject?: { enabled?: boolean; alwaysApplyFolder?: string; position?: "before" | "after-persona" }
          }
        ).rulesInject ?? {}
      activeConfig = mergeConfig(partial)
      log.info("config: rules-inject configured", {
        enabled: activeConfig.enabled,
        folder: activeConfig.alwaysApplyFolder,
        position: activeConfig.position,
      })
    },
    "experimental.chat.system.transform": async (input, output) => {
      // DEBUG: log input object structure
      log.info("DEBUG: system.transform input", {
        sessionID: input.sessionID,
        inputKeys: Object.keys(input),
        agent: (input as any).agent,
        agentName: (input as any).agentName,
      })

      if (!activeConfig.enabled) {
        log.debug("rules-inject disabled")
        return
      }

      if (!input.sessionID) {
        log.debug("rules-inject: no sessionID, skipping")
        return
      }

      // Skip injection for internal system agents (not in user-defined agents)
      if (input.agent && !userAgents.has(input.agent)) {
        log.debug("skipping rules injection for internal agent", { agent: input.agent })
        return
      }

      const injectKey = `${input.sessionID}:${input.agent}`
      if (injected.has(injectKey)) {
        return
      }

      const rules = await loadRules(activeConfig.alwaysApplyFolder)
      if (!rules) {
        log.warn("rules-inject: no rules loaded from folder", {
          folder: activeConfig.alwaysApplyFolder,
        })
        return
      }

      if (output.system.length === 0) {
        log.warn("empty system prompt, cannot inject")
        return
      }

      // DEBUG: log rules being injected
      log.info("DEBUG: about to inject rules", {
        sessionID: input.sessionID,
        rulesLength: rules.length,
        rulesPreview: rules.slice(0, 500),
        position: activeConfig.position,
      })

      // DEBUG: log original system prompt before injection
      // log.info("DEBUG: original system prompt", {
      //   sessionID: input.sessionID,
      //   systemLength: output.system[0].length,
      //   systemPreview: output.system[0].slice(0, 500),
      // })

      if (activeConfig.position === "after-persona") {
        const marker = "You are powered by the model named"
        const idx = output.system[0].indexOf(marker)
        if (idx !== -1) {
          output.system[0] = output.system[0].slice(0, idx) + rules + "\n\n" + output.system[0].slice(idx)
        } else {
          log.debug("env marker not found; falling back to prepend")
          output.system[0] = rules + "\n\n" + output.system[0]
        }
      } else {
        output.system[0] = rules + "\n\n" + output.system[0]
      }

      // DEBUG: log injected system prompt after injection
      // log.info("DEBUG: injected system prompt", {
      //   sessionID: input.sessionID,
      //   systemLength: output.system[0].length,
      //   systemPreview: output.system[0].slice(0, 500),
      // })

      log.info("injected rules", {
        sessionID: input.sessionID,
        agent: input.agent,
        rulesLength: rules.length,
        position: activeConfig.position,
      })
      injected.add(injectKey)
    },
  }
}

export * as Log from "./log"

import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import * as Global from "../global"
import { Schema } from "effect"
import { Glob } from "./glob"

export const Level = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})
export type Level = Schema.Schema.Type<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const keep = 10
const initializedRunID = "OPENCODE_LOG_INITIALIZED_RUN_ID"

// --- Tools Log ---
const TOOLS_LOG_ENABLED = process.env.OPENCODE_LOG_TOOLS === "1"
const toolsKeep = 5
let toolsWrite: ((msg: string) => void) | null = null

// Max-lines rotation config
const TOOLS_LOG_MAX_LINES = (() => {
  const raw = process.env.TOOL_LOG_FILE_MAX_LINES
  if (raw == null || raw === "") return 1000
  const n = Number(raw)
  return n > 0 ? n : null
})()
let toolsLineCount = 0
let toolsRotating = false
let toolsRotationPending = false
let toolsRotationTimer: ReturnType<typeof setTimeout> | null = null

function reopenToolsWriteStream() {
  const toolsLogPath = path.join(Global.Path.log, "tools.log")
  const stream = createWriteStream(toolsLogPath, { flags: "a" })
  toolsWrite = (msg: string) => { stream.write(msg) }
}

let level: Level = "INFO"

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: Record<string, any>,
  ): {
    stop(): void
    [Symbol.dispose](): void
  }
}

const loggers = new Map<string, Logger>()

export const Default = create({ service: "default" })

export interface Options {
  print: boolean
  dev?: boolean
  level?: Level
}

let logpath = ""
export function file() {
  return logpath
}
let write = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}

export async function init(options: Options) {
  if (options.level) level = options.level
  void cleanup(Global.Path.log)
  if (TOOLS_LOG_ENABLED) {
    await initToolsLog()
  }
  if (options.print) return
  logpath = path.join(
    Global.Path.log,
    options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
  )
  const runID = process.env.OPENCODE_RUN_ID
  const shouldTruncate = !options.dev || !runID || process.env[initializedRunID] !== runID
  if (shouldTruncate) await fs.truncate(logpath).catch(() => {})
  if (options.dev && runID) process.env[initializedRunID] = runID
  const stream = createWriteStream(logpath, { flags: "a" })
  write = async (msg: any) => {
    return new Promise((resolve, reject) => {
      stream.write(msg, (err) => {
        if (err) reject(err)
        else resolve(msg.length)
      })
    })
  }
}

async function scheduleToolsRotation() {
  if (toolsRotating) {
    toolsRotationPending = true
    return
  }
  toolsRotating = true
  try {
    await rotateToolsLog()
    toolsLineCount = 0
    reopenToolsWriteStream()
    if (toolsRotationPending) {
      toolsRotationPending = false
      await rotateToolsLog()
      toolsLineCount = 0
      reopenToolsWriteStream()
    }
  } finally {
    toolsRotating = false
  }
}

export async function rotateToolsLog() {
  const dir = Global.Path.log
  const base = "tools"
  // Drop oldest backup
  const oldest = path.join(dir, `${base}-${toolsKeep}.log`)
  await fs.unlink(oldest).catch(() => {})
  // Shift backups: tools-4 → tools-5, tools-3 → tools-4, ..., tools → tools-1
  for (let i = toolsKeep - 1; i >= 1; i--) {
    const src = path.join(dir, `${base}-${i}.log`)
    const dst = path.join(dir, `${base}-${i + 1}.log`)
    await fs.rename(src, dst).catch(() => {})
  }
  // Shift current → tools-1
  const current = path.join(dir, `${base}.log`)
  const firstBackup = path.join(dir, `${base}-1.log`)
  await fs.rename(current, firstBackup).catch(() => {})
  // Truncate (create fresh current)
  await fs.writeFile(current, "").catch(() => {})
}

export async function initToolsLog() {
  const dir = Global.Path.log
  await fs.mkdir(dir, { recursive: true }).catch(() => {})
  // Rotate on start
  await rotateToolsLog()
  toolsLineCount = 0
  // Open write stream
  reopenToolsWriteStream()

  if (TOOLS_LOG_MAX_LINES != null) {
    const onExit = () => {
      if (toolsLineCount >= TOOLS_LOG_MAX_LINES && !toolsRotating) {
        void rotateToolsLog()
        toolsLineCount = 0
      }
    }
    process.on("exit", onExit)
    process.on("SIGTERM", onExit)
    process.on("SIGINT", onExit)
  }
}

export function toolsLog(entry: Record<string, unknown>): void {
  if (!TOOLS_LOG_ENABLED || !toolsWrite) return
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n"
  toolsWrite(line)
  if (TOOLS_LOG_MAX_LINES != null) {
    toolsLineCount++
    if (toolsLineCount >= TOOLS_LOG_MAX_LINES && !toolsRotating) {
      if (toolsRotationTimer) clearTimeout(toolsRotationTimer)
      toolsRotationTimer = setTimeout(scheduleToolsRotation, 100)
    }
  }
}

async function cleanup(dir: string) {
  const files = (
    await Glob.scan("????-??-??T??????.log", {
      cwd: dir,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .filter((file) => path.basename(file) === file)
    .sort()
  if (files.length <= keep) return

  const doomed = files.slice(0, -keep)
  await Promise.all(doomed.map((file) => fs.unlink(path.join(dir, file)).catch(() => {})))
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

let last = Date.now()
export function create(tags?: Record<string, any>) {
  tags = tags || {}

  const service = tags["service"]
  if (service && typeof service === "string") {
    const cached = loggers.get(service)
    if (cached) {
      return cached
    }
  }

  function build(message: any, extra?: Record<string, any>) {
    const prefix = Object.entries({
      ...tags,
      ...extra,
    })
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const prefix = `${key}=`
        if (value instanceof Error) return prefix + formatError(value)
        if (typeof value === "object") return prefix + JSON.stringify(value)
        return prefix + value
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
  }
  const result: Logger = {
    debug(message?: any, extra?: Record<string, any>) {
      if (shouldLog("DEBUG")) {
        write("DEBUG " + build(message, extra))
      }
    },
    info(message?: any, extra?: Record<string, any>) {
      if (shouldLog("INFO")) {
        write("INFO  " + build(message, extra))
      }
    },
    error(message?: any, extra?: Record<string, any>) {
      if (shouldLog("ERROR")) {
        write("ERROR " + build(message, extra))
      }
    },
    warn(message?: any, extra?: Record<string, any>) {
      if (shouldLog("WARN")) {
        write("WARN  " + build(message, extra))
      }
    },
    tag(key: string, value: string) {
      if (tags) tags[key] = value
      return result
    },
    clone() {
      return create({ ...tags })
    },
    time(message: string, extra?: Record<string, any>) {
      const now = Date.now()
      result.info(message, { status: "started", ...extra })
      function stop() {
        result.info(message, {
          status: "completed",
          duration: Date.now() - now,
          ...extra,
        })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }

  if (service && typeof service === "string") {
    loggers.set(service, result)
  }

  return result
}

import path from "path"
import { Effect } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigMarkdown } from "@/config/markdown"
import { Skill } from "@/skill"
import * as SessionMetadata from "@/skill/session-metadata"
import * as Log from "@opencode-ai/core/util/log"
import { isRecord } from "@/util/record"
import type { Part } from "@/session/message-v2"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"

const log = Log.create({ service: "dynamic-scanner", tag: "dynamic-skills" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CacheEntry = {
  skills: Skill.Info[]
  timestamp: number
}

export type ScanResult = {
  agentsDirs: string[]
  skills: Skill.Info[]
}

export type ScanPartsResult = {
  pathsFound: number
  scannedPaths: string[]
  skillsRegistered: number
  skillNames: string[]
}

export type ScanToolArgsResult = {
  pathsFound: number
  scannedPaths: string[]
  skillsRegistered: number
  skillNames: string[]
}

export type InjectDiscoveredSkillsResult = {
  injected: number
  skillCount: number
  xml?: string
}

const MAX_WALK_DEPTH = 50
const AGENTS_DIR = ".agents"
const OPENCODE_DIR = ".opencode"
const CLAUDE_DIR = ".claude"
const SKILLS_PATTERN = "skills/**/SKILL.md"
const SKILL_PATTERN = "skill/**/SKILL.md"

// In-memory cache keyed by realpath of the directory being scanned
const scanCache = new Map<string, CacheEntry>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

const resolveRealpath = Effect.fnUntraced(function* (dir: string) {
  return yield* Effect.try({
    try: () => path.resolve(dir),
    catch: () => dir,
  })
})

// ---------------------------------------------------------------------------
// findAgentsDirectories
// ---------------------------------------------------------------------------

/**
 * Walk up from the file's directory, checking each level for .agents/ directories.
 * Returns all found .agents/ directories, closest first.
 * Max depth of 50 levels.
 */
export const findAgentsDirectories = Effect.fnUntraced(function* (filePath: string) {
  const startDir = path.dirname(filePath)
  const found: string[] = []
  let current = yield* resolveRealpath(startDir)
  let depth = 0

  while (depth < MAX_WALK_DEPTH) {
    const agentsDir = path.join(current, AGENTS_DIR)
    const resolved = yield* resolveRealpath(agentsDir)

    const isDir = yield* AppFileSystem.Service.pipe(
      Effect.flatMap((fsys) => fsys.isDir(resolved)),
      Effect.catch(() => Effect.succeed(false)),
    )

    if (isDir) {
      found.push(resolved)
      log.debug("found-agents-dir", { dir: resolved, depth })
    }

    const parent = path.dirname(current)
    if (parent === current) break // reached root
    current = parent
    depth++
  }

  if (found.length > 0) {
    log.info("walk-up-complete", {
      filePath,
      foundCount: found.length,
      dirs: found,
    })
  }

  return found
})

// ---------------------------------------------------------------------------
// scanAgentsSkills
// ---------------------------------------------------------------------------

/**
 * Scan a directory (e.g. .agents/, .opencode/, .claude/) for SKILL.md files.
 * Uses Glob.scan and ConfigMarkdown.parse, validates with isSkillFrontmatter.
 */
export const scanAgentsSkills = Effect.fnUntraced(function* (agentsDir: string) {
  const cacheKey = yield* resolveRealpath(agentsDir)

  // Check cache
  const cached = scanCache.get(cacheKey)
  if (cached) {
    log.debug("cache-hit", { dir: cacheKey, skillsCount: cached.skills.length })
    return cached.skills
  }

  log.debug("cache-miss", { dir: cacheKey })

  const skills: Skill.Info[] = []
  const scannedPatterns: string[] = []

  // Determine patterns based on directory name
  const dirName = path.basename(agentsDir)
  if (dirName === AGENTS_DIR) {
    scannedPatterns.push(SKILLS_PATTERN)
  } else if (dirName === OPENCODE_DIR) {
    scannedPatterns.push(SKILLS_PATTERN, SKILL_PATTERN)
  } else if (dirName === CLAUDE_DIR) {
    scannedPatterns.push(SKILLS_PATTERN)
  }

  // Scan each pattern
  for (const pattern of scannedPatterns) {
    const matches = yield* Effect.tryPromise({
      try: () =>
        Glob.scan(pattern, {
          cwd: agentsDir,
          absolute: true,
          include: "file",
          symlink: true,
          dot: true,
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) => {
        log.warn("glob-scan-error", { dir: agentsDir, pattern, error: String(error) })
        return Effect.succeed([] as string[])
      }),
    )

    for (const match of matches) {
      const resolvedMatch = yield* resolveRealpath(match)

      // Parse the SKILL.md file
      const md = yield* Effect.tryPromise({
        try: () => ConfigMarkdown.parse(resolvedMatch),
        catch: (err) => err,
    }).pipe(
      Effect.catch((err) => {
        log.warn("failed-to-parse-skill", { skill: resolvedMatch, error: String(err) })
        return Effect.succeed(undefined)
      }),
      )

      if (!md) continue
      if (!isSkillFrontmatter(md.data)) {
        log.warn("invalid-skill-frontmatter", { skill: resolvedMatch })
        continue
      }

      skills.push({
        name: md.data.name,
        description: md.data.description,
        location: resolvedMatch,
        content: md.content,
      })
    }
  }

  // Store in cache
  scanCache.set(cacheKey, { skills, timestamp: Date.now() })
  log.info("scan-complete", { dir: cacheKey, skillsCount: skills.length })

  return skills
})

// ---------------------------------------------------------------------------
// scanForFile
// ---------------------------------------------------------------------------

/**
 * Combined operation: find .agents/ directories for a file, scan for skills,
 * deduplicate, and return results.
 * Non-blocking: wrapped in catchAll so errors don't propagate.
 */
const scanForFileInternal = Effect.fnUntraced(function* (
  filePath: string,
  sessionID: string,
 ) {
  // Resolve the file path first
  const resolvedFile = yield* resolveRealpath(filePath)

  // Check if file's parent directory exists
  const parentExists = yield* AppFileSystem.Service.pipe(
    Effect.flatMap((fsys) => fsys.isDir(path.dirname(resolvedFile))),
    Effect.timeout(1000),
    Effect.catch(() => Effect.succeed(false)),
  )

  if (!parentExists) {
    log.debug("file-parent-not-found", { filePath: resolvedFile })
    return { agentsDirs: [], skills: [] } as ScanResult
  }

  // Find all .agents/ directories
  log.info("find-agents-dirs-start", { filePath: resolvedFile })
  const agentsDirs = yield* findAgentsDirectories(resolvedFile).pipe(
    Effect.timeout(2000),
    Effect.catch((error) => {
      log.warn("find-agents-dirs-error", { filePath: resolvedFile, error: String(error) })
      return Effect.succeed([] as string[])
    }),
  )

  if (agentsDirs.length === 0) {
    log.debug("no-agents-dirs-found", { filePath: resolvedFile })
    return { agentsDirs: [], skills: [] } as ScanResult
  }

  // Scan each .agents/ directory for skills
  const allSkills: Skill.Info[] = []
  const seenNames = new Set<string>()

  for (const agentsDir of agentsDirs) {
    // Check if this directory was already scanned for this session (deduplication)
    const alreadyScanned = yield* SessionMetadata.wasDirectoryScanned(sessionID, agentsDir).pipe(
      Effect.catch(() => Effect.succeed(false))
    )

    if (alreadyScanned) {
      log.debug("directory-already-scanned", { dir: agentsDir, sessionID })
      continue
    }

    const dirSkills = yield* scanAgentsSkills(agentsDir).pipe(
      Effect.catch((error) => {
        log.warn("scan-agents-skills-error", { dir: agentsDir, error: String(error) })
        return Effect.succeed([] as Skill.Info[])
      }),
    )

    // Mark directory as scanned for this session
    if (dirSkills.length > 0) {
      yield* SessionMetadata.addScannedDirectory(sessionID, agentsDir).pipe(
        Effect.catch(() => Effect.void)
      )
    }

    for (const skill of dirSkills) {
      if (!seenNames.has(skill.name)) {
        seenNames.add(skill.name)
        allSkills.push(skill)
      }
    }
  }

  log.info("scan-for-file-complete", {
    filePath: resolvedFile,
    sessionID,
    agentsDirsCount: agentsDirs.length,
    skillsCount: allSkills.length,
    skillNames: allSkills.map((s) => s.name),
  })

  return { agentsDirs, skills: allSkills }
})

export const scanForFile = Effect.fnUntraced(function* (
  filePath: string,
  sessionID: string,
) {
  return yield* scanForFileInternal(filePath, sessionID).pipe(
    Effect.catch((error) => {
      log.warn("scan-for-file-error", { filePath, sessionID, error: String(error) })
      return Effect.succeed({ agentsDirs: [], skills: [] } as ScanResult)
    }),
  )
})

// ---------------------------------------------------------------------------
// scanParts
// ---------------------------------------------------------------------------

/**
 * Extract absolute file paths from message parts and trigger dynamic skill discovery.
 * Scans:
 * - Text parts: absolute paths via regex (Unix /... and Windows C:\...)
 * - Text parts: synthetic Read tool references with "filePath":"..."
 * - File parts: source.path (file/symbol sources)
 * - File parts: filename when it is an absolute path
 *
 * Deduplicates paths by resolved realpath before scanning.
 * Synchronous with 5-second overall timeout: scan completes before agent response to avoid fork kill race.
 */
export const scanParts = Effect.fnUntraced(function* (
  parts: Part[],
  sessionID: SessionID,
  agent: string,
  providerID: ProviderID,
  modelID: ModelID,
) {
  // Regex for absolute paths: Unix (/...) or Windows (C:\...)
  const absPathRegex = /((?:^|[\s"'`({,])((?:\/[^"\s'`)}\],]+)|(?:[A-Za-z]:\\[^"\s'`)}\],]+)))/g

  function isAbsolutePath(p: string): boolean {
    return path.isAbsolute(p) || /^[A-Za-z]:\\/.test(p)
  }

  const rawPaths = new Set<string>()

  for (const part of parts) {
    if (part.type === "text") {
      // Extract absolute paths from text
      let match: RegExpExecArray | null
      while ((match = absPathRegex.exec(part.text)) !== null) {
        const fullMatch = match[1]
        const candidate = match[2] || fullMatch
        if (candidate && isAbsolutePath(candidate)) {
          rawPaths.add(candidate)
        }
      }

      // Also extract from synthetic Read tool references: {"filePath":"..."}
      const filePathMatches = part.text.matchAll(/"filePath"\s*:\s*"([^"]+)"/g)
      for (const m of filePathMatches) {
        const candidate = m[1]
        if (candidate && isAbsolutePath(candidate)) {
          rawPaths.add(candidate)
        }
      }
    }

    if (part.type === "file") {
      // Extract from source.path (file or symbol source)
      if (part.source && "path" in part.source) {
        const srcPath = part.source.path
        if (srcPath && isAbsolutePath(srcPath)) {
          rawPaths.add(srcPath)
        }
      }

      // Extract from filename if it's an absolute path
      if (part.filename && isAbsolutePath(part.filename)) {
        rawPaths.add(part.filename)
      }
    }
  }

  if (rawPaths.size === 0) {
    log.debug("trigger-prompt", { sessionID, partType: "none", pathCount: 0 })
    return { pathsFound: 0, scannedPaths: [], skillsRegistered: 0, skillNames: [] }
  }

  log.info("trigger-prompt", {
    sessionID,
    partType: "mixed",
    pathCount: rawPaths.size,
  })

  // Wrap async scan logic in 5-second timeout (safety net since scan is now synchronous)
  return yield* Effect.gen(function* () {
    // Deduplicate by resolved realpath
    const uniquePaths = new Map<string, string>()
    for (const rawPath of rawPaths) {
      const resolved = yield* resolveRealpath(rawPath)
      if (!uniquePaths.has(resolved)) {
        uniquePaths.set(resolved, rawPath)
      }
    }

    log.info("scan-parts-start", { sessionID, pathCount: rawPaths.size, uniqueCount: uniquePaths.size })

    // Scan each unique path and collect skills
    const scannedPaths: string[] = []
    const allNewSkills: Skill.Info[] = []

    for (const [resolvedPath, rawPath] of uniquePaths) {
      log.info("scan-parts-path-resolved", { sessionID, path: resolvedPath })
      const result = yield* scanForFile(resolvedPath, sessionID).pipe(
        Effect.timeout(2000),
        Effect.catch((error) => {
          log.warn("scan-parts-scan-error", { path: resolvedPath, sessionID, error: String(error) })
          return Effect.succeed({ agentsDirs: [], skills: [] })
        }),
      )

      if (result.skills.length > 0) {
        scannedPaths.push(rawPath)
        allNewSkills.push(...result.skills)
      }
    }

    // Register discovered skills via Skill.Service and track for injection
    let skillsRegistered = 0
    let skillNames: string[] = []

    if (allNewSkills.length > 0) {
      const registration = yield* Skill.Service.pipe(
        Effect.flatMap((svc) => svc.registerDynamic(allNewSkills)),
        Effect.catch((error) => {
          log.warn("scan-parts-register-error", { sessionID, error: String(error) })
          return Effect.succeed({ added: 0, skipped: allNewSkills.length })
        }),
      )

      skillsRegistered = registration.added
      skillNames = allNewSkills.map((s) => s.name)

      // Track newly registered skills for injection and session metadata
      // Only inject skills that were actually newly registered (registration.added > 0)
      if (skillsRegistered > 0) {
        for (const skill of allNewSkills) {
          if (!injectionQueue.has(skill.name)) {
            injectionQueue.set(skill.name, skill)
          }
          // Record skill registration in session metadata (for post-compaction restoration)
          yield* SessionMetadata.addRegisteredSkill(sessionID, skill).pipe(
            Effect.catch(() => Effect.void)
          )
        }
      } else {
        // Skills were already registered — still record in session metadata
        for (const skill of allNewSkills) {
          yield* SessionMetadata.addRegisteredSkill(sessionID, skill).pipe(
            Effect.catch(() => Effect.void)
          )
        }
      }

      if (skillsRegistered > 0) {
        log.info("scan-parts-skills-registered", {
          sessionID,
          count: skillsRegistered,
          names: skillNames,
        })
      }
    }

    // Self-inject discovered skills (two-phase: format → flush)
    const injectResult = yield* injectDiscoveredSkills(sessionID)
    if (injectResult.injected > 0 && injectResult.xml) {
      yield* flushInjectedMessages({
        injected: [{ role: "user", text: injectResult.xml }],
        sessionID,
        agent,
        providerID,
        modelID,
      })
    }

    log.info("scan-parts-end", { sessionID })

    return {
      pathsFound: rawPaths.size,
      scannedPaths,
      skillsRegistered,
      skillNames,
    }
  }).pipe(
    Effect.timeout(5000),
    Effect.catchTag("TimeoutError", () => {
      log.warn("scan-parts-timeout", { sessionID, message: "scan exceeded 5-second timeout" })
      return Effect.succeed({ pathsFound: rawPaths.size, scannedPaths: [], skillsRegistered: 0, skillNames: [] })
    }),
  )
})

// ---------------------------------------------------------------------------
// scanToolArgs
// ---------------------------------------------------------------------------

/**
 * Extract file paths from tool execution arguments and trigger dynamic skill discovery.
 * Handles known built-in tools:
 * - read, write, edit: args.filePath
 * - glob: args.pattern (extract directory component)
 * - grep: args.path
 * - apply_patch: extract paths from +++ b/ lines in patch text
 *
 * Unknown tools are handled gracefully as no-op with debug log.
 * Synchronous with 5-second overall timeout: completes before tool returns to ensure skills are registered.
 */
export const scanToolArgs = Effect.fnUntraced(function* (
  toolId: string,
  args: Record<string, unknown>,
  sessionID: SessionID,
  agent: string,
  providerID: ProviderID,
  modelID: ModelID,
) {
  const paths = new Set<string>()

  // Extract paths based on tool type
  if (toolId === "read" || toolId === "write" || toolId === "edit") {
    const filePath = args.filePath
    if (typeof filePath === "string" && filePath.length > 0) {
      paths.add(filePath)
    }
  } else if (toolId === "glob") {
    const pattern = args.pattern
    if (typeof pattern === "string" && pattern.length > 0) {
      // Extract directory component from glob pattern
      // Remove glob wildcards from the end to get the base directory
      const dir = pattern.replace(/\/\*\*\/[^/]*$/, "").replace(/\/\*[^/]*$/, "")
      if (dir && (path.isAbsolute(dir) || /^[A-Za-z]:\\/.test(dir))) {
        paths.add(dir)
      }
    }
  } else if (toolId === "grep") {
    const grepPath = args.path
    if (typeof grepPath === "string" && grepPath.length > 0) {
      paths.add(grepPath)
    }
  } else if (toolId === "apply_patch") {
    const patch = args.patch
    if (typeof patch === "string" && patch.length > 0) {
      // Extract paths from +++ b/<path> lines in unified diff format
      const patchLines = patch.split("\n")
      for (const line of patchLines) {
        if (line.startsWith("+++ b/")) {
          const extractedPath = line.slice(6) // remove "+++ b/"
          if (extractedPath && extractedPath.length > 0) {
            paths.add(extractedPath)
          }
        }
      }
    }
  } else {
    // Unknown tool — no-op, log for visibility
    log.debug("unknown-tool", { toolId, sessionID })
    return { pathsFound: 0, scannedPaths: [], skillsRegistered: 0, skillNames: [] }
  }

  if (paths.size === 0) {
    log.debug("trigger-tool", { toolId, sessionID, filePath: "none", pathCount: 0 })
    return { pathsFound: 0, scannedPaths: [], skillsRegistered: 0, skillNames: [] }
  }

  log.info("trigger-tool", {
    toolId,
    sessionID,
    filePath: Array.from(paths),
    pathCount: paths.size,
  })

  // Wrap async scan logic in 5-second timeout (safety net since scan is now synchronous)
  return yield* Effect.gen(function* () {
    // Deduplicate by resolved realpath
    const uniquePaths = new Map<string, string>()
    for (const rawPath of paths) {
      const resolved = yield* resolveRealpath(rawPath)
      if (!uniquePaths.has(resolved)) {
        uniquePaths.set(resolved, rawPath)
      }
    }

    // Scan each unique path and collect skills
    const scannedPaths: string[] = []
    const allNewSkills: Skill.Info[] = []

    for (const [resolvedPath, rawPath] of uniquePaths) {
      const result = yield* scanForFile(resolvedPath, sessionID).pipe(
        Effect.timeout(2000),
        Effect.catch((error) => {
          log.warn("scan-tool-args-scan-error", { path: resolvedPath, toolId, sessionID, error: String(error) })
          return Effect.succeed({ agentsDirs: [], skills: [] })
        }),
      )

      if (result.skills.length > 0) {
        scannedPaths.push(rawPath)
        allNewSkills.push(...result.skills)
      }
    }

    // Register discovered skills via Skill.Service and track for injection
    let skillsRegistered = 0
    let skillNames: string[] = []

    if (allNewSkills.length > 0) {
      const registration = yield* Skill.Service.pipe(
        Effect.flatMap((svc) => svc.registerDynamic(allNewSkills)),
        Effect.catch((error) => {
          log.warn("scan-tool-args-register-error", { toolId, sessionID, error: String(error) })
          return Effect.succeed({ added: 0, skipped: allNewSkills.length })
        }),
      )

      skillsRegistered = registration.added
      skillNames = allNewSkills.map((s) => s.name)

      // Track newly registered skills for injection and session metadata
      // Only inject skills that were actually newly registered (registration.added > 0)
      if (skillsRegistered > 0) {
        for (const skill of allNewSkills) {
          if (!injectionQueue.has(skill.name)) {
            injectionQueue.set(skill.name, skill)
          }
          // Record skill registration in session metadata (for post-compaction restoration)
          yield* SessionMetadata.addRegisteredSkill(sessionID, skill).pipe(
            Effect.catch(() => Effect.void)
          )
        }
      } else {
        // Skills were already registered — still record in session metadata
        for (const skill of allNewSkills) {
          yield* SessionMetadata.addRegisteredSkill(sessionID, skill).pipe(
            Effect.catch(() => Effect.void)
          )
        }
      }

      if (skillsRegistered > 0) {
        log.info("scan-tool-args-skills-registered", {
          toolId,
          sessionID,
          count: skillsRegistered,
          names: skillNames,
        })
      }
    }

    // Self-inject discovered skills (two-phase: format → flush)
    const injectResult = yield* injectDiscoveredSkills(sessionID).pipe(
      Effect.catch(() => Effect.succeed({ injected: 0, skillCount: 0 } as InjectDiscoveredSkillsResult)),
    )
    if (injectResult.injected > 0 && injectResult.xml != null) {
      yield* flushInjectedMessages({
        injected: [{ role: "user", text: injectResult.xml }],
        sessionID,
        agent,
        providerID,
        modelID,
      }).pipe(
        Effect.catch(() => Effect.void),
      )
    }

    return {
      pathsFound: paths.size,
      scannedPaths,
      skillsRegistered,
      skillNames,
    }
  }).pipe(
    Effect.timeout(5000),
    Effect.catchTag("TimeoutError", () => {
      log.warn("scan-tool-args-timeout", { toolId, sessionID, message: "scan exceeded 5-second timeout" })
      return Effect.succeed({ pathsFound: paths.size, scannedPaths: [], skillsRegistered: 0, skillNames: [] })
    }),
  )
})

// ---------------------------------------------------------------------------
// injectDiscoveredSkills
// ---------------------------------------------------------------------------

/**
 * Format dynamically discovered skills as a synthetic user message and prepare it for injection.
 * Reads dynamicSkills from Skill.Service, formats them as <available_skills> XML using
 * the same format as Skill.fmt(list, {verbose: true}), and returns the formatted text.
 *
 * Deduplication: only includes skills that are currently in dynamicSkills (not yet promoted).
 * The caller (tools.ts) is responsible for calling flushInjectedMessages with the result.
 *
 * Non-blocking: wrapped in catchAll so errors don't propagate.
 */
export const injectDiscoveredSkills = Effect.fnUntraced(function* (
  sessionID: string,
) {
  try {
    // Get dynamic skills from injection queue
    const dynamicSkills = getDynamicSkillsForInjection()

    if (dynamicSkills.length === 0) {
      log.debug("injectDiscoveredSkills-none", { sessionID })
      return { injected: 0, skillCount: 0 }
    }

    // Format skills as <available_skills> XML (same format as Skill.fmt with verbose: true)
    const described = dynamicSkills.filter((skill) => skill.description !== undefined)
    const xml = [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${skill.location}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")

    log.info("synthetic-injected", {
      sessionID,
      skillCount: described.length,
      skillNames: described.map((s) => s.name),
    })

    // Clear the injection queue after formatting — caller will flush the message
    clearDynamicSkillsInjectionQueue()

    return { injected: 1, skillCount: described.length, xml }
  } catch (error) {
    log.warn("injectDiscoveredSkills-error", { error: String(error) })
    return { injected: 0, skillCount: 0 }
  }
})

// ---------------------------------------------------------------------------
// Internal: injection queue for dynamic skills
// ---------------------------------------------------------------------------

/**
 * Module-level queue that tracks newly registered dynamic skills pending injection.
 * scanToolArgs and scanParts register skills via Skill.Service.registerDynamic,
 * then add them here so injectDiscoveredSkills can format them.
 */
const injectionQueue = new Map<string, Skill.Info>()

/**
 * Called by registerDynamic wrapper to track skills for injection.
 */
export const trackSkillForInjection = Effect.fnUntraced(function* (skill: Skill.Info) {
  if (!injectionQueue.has(skill.name)) {
    injectionQueue.set(skill.name, skill)
  }
})

/**
 * Get all skills currently in the injection queue.
 */
function getDynamicSkillsForInjection(): Skill.Info[] {
  return Array.from(injectionQueue.values())
}

/**
 * Clear the injection queue after skills have been injected.
 */
function clearDynamicSkillsInjectionQueue() {
  injectionQueue.clear()
}

// ---------------------------------------------------------------------------
// flushInjectedMessages
// ---------------------------------------------------------------------------

/**
 * Flush synthetic user messages injected by dynamic skill discovery.
 * Persists messages via Session.Service so they survive compaction.
 * System-role injections are wrapped in <system-reminder> tags.
 */
export const flushInjectedMessages = Effect.fn("DynamicSkillScanner.flushInjectedMessages")(function* (input: {
  injected: Array<{ role: "user" | "system"; text: string }>
  sessionID: SessionID
  agent: string
  providerID: ProviderID
  modelID: ModelID
}) {
  if (input.injected.length === 0) return

  const sessions = yield* Session.Service

  for (const injection of input.injected) {
    const isSystem = injection.role === "system"
    const wrapped = isSystem
      ? `<system-reminder>${injection.text}</system-reminder>`
      : injection.text

    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.agent,
      model: { providerID: input.providerID, modelID: input.modelID },
    }
    yield* sessions.updateMessage(userMsg)

    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      type: "text",
      text: wrapped,
      synthetic: true,
    } satisfies MessageV2.TextPart)
  }
})

// ---------------------------------------------------------------------------
// Export namespace
// ---------------------------------------------------------------------------

export * as DynamicSkillScanner from "./dynamic-scanner"

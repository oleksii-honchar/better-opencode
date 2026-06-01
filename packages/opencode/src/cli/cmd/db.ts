import type { Argv } from "yargs"
import { spawn } from "child_process"
import { statSync, existsSync } from "fs"
import { Database } from "@/storage/db"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { Database as BunDatabase } from "bun:sqlite"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { JsonMigration } from "@/storage/json-migration"
import { EOL } from "os"
import { errorMessage } from "../../util/error"

// ---------------------------------------------------------------------------
// Helper functions (exported for testing)
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function runVacuum(dbPath: string): { freedBytes: number } {
  const db = new BunDatabase(dbPath)
  try {
    const beforeSize = statSync(dbPath).size
    db.run("VACUUM")
    db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    const afterSize = statSync(dbPath).size
    return { freedBytes: beforeSize - afterSize }
  } finally {
    db.close()
  }
}

export function runCheckpoint(dbPath: string): void {
  const db = new BunDatabase(dbPath)
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
  }
}

export function runStats(dbPath: string): void {
  const db = new BunDatabase(dbPath, { readonly: true })
  try {
    const dbFileSize = statSync(dbPath).size
    const walPath = dbPath + "-wal"
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0
    const pageSize = (db.prepare("PRAGMA page_size").get() as Record<string, unknown>)?.page_size as number ?? 0
    const freelistCount =
      (db.prepare("PRAGMA freelist_count").get() as Record<string, unknown>)?.freelist_count as number ?? 0
    const sessionCount = (db.prepare("SELECT count(*) as c FROM session").get() as Record<string, unknown>)?.c as number ?? 0
    const messageCount = (db.prepare("SELECT count(*) as c FROM message").get() as Record<string, unknown>)?.c as number ?? 0
    const partCount = (db.prepare("SELECT count(*) as c FROM part").get() as Record<string, unknown>)?.c as number ?? 0
    const oldestSession = (db.prepare("SELECT min(time_created) as t FROM session").get() as Record<string, unknown>)?.t as
      | number
      | null

    console.log(`DB file size:         ${formatBytes(dbFileSize)}`)
    console.log(`WAL file size:        ${formatBytes(walSize)}`)
    console.log(`Page size:            ${pageSize} bytes`)
    console.log(`Free pages:           ${freelistCount} (${formatBytes(freelistCount * pageSize)})`)
    console.log(`session rows:         ${sessionCount}`)
    console.log(`message rows:         ${messageCount}`)
    console.log(`part rows:            ${partCount}`)
    console.log(`Total rows:           ${sessionCount + messageCount + partCount}`)

    if (oldestSession) {
      console.log(`Oldest session:       ${new Date(oldestSession).toISOString()}`)
    } else {
      console.log(`Oldest session:       (no sessions)`)
    }

    const recommendVacuum = freelistCount > 1000 || dbFileSize > 100 * 1024 * 1024
    console.log(`VACUUM recommended:   ${recommendVacuum ? "Yes" : "No"}`)
    if (freelistCount > 1000) {
      console.log(`  (${freelistCount} free pages > 1000 threshold)`)
    }
    if (dbFileSize > 100 * 1024 * 1024) {
      console.log(`  (${formatBytes(dbFileSize)} > 100 MB threshold)`)
    }
  } finally {
    db.close()
  }
}

export function runCompact(
  dbPath: string,
  options: { dryRun: boolean; olderThan?: string },
): { deletedParts: number } {
  const db = new BunDatabase(dbPath)
  try {
    const olderThanStr = options.olderThan ?? "90d"
    const days = parseInt(olderThanStr, 10) || 90
    const cutoffMs = Date.now() - days * 86400000

    let totalDeleted = 0

    // Step 1: Count/delete compacted parts (any age)
    if (options.dryRun) {
      const compactedCount =
        (
          db
            .prepare("SELECT count(*) as c FROM part WHERE json_extract(data, '$.state.time.compacted') IS NOT NULL")
            .get() as Record<string, unknown>
        )?.c ?? 0
      totalDeleted += (compactedCount as number)
      console.log(`[dry-run] Would delete ${compactedCount} compacted parts`)
    } else {
      const compactedResult = db.run(
        "DELETE FROM part WHERE json_extract(data, '$.state.time.compacted') IS NOT NULL",
      )
      totalDeleted += (compactedResult as { changes?: number })?.changes ?? 0
    }

    // Step 2: Count/delete old tool parts (older than threshold)
    if (options.dryRun) {
      const oldToolCount =
        (
          db
            .prepare(
              "SELECT count(*) as c FROM part WHERE time_created < ?1 AND json_extract(data, '$.type') = 'tool'",
            )
            .get(cutoffMs) as Record<string, unknown>
        )?.c ?? 0
      totalDeleted += (oldToolCount as number)
      console.log(`[dry-run] Would delete ${oldToolCount} old tool parts (older than ${olderThanStr})`)
    } else {
      const toolResult = db.run(
        "DELETE FROM part WHERE time_created < ?1 AND json_extract(data, '$.type') = 'tool'",
        [cutoffMs],
      )
      totalDeleted += (toolResult as { changes?: number })?.changes ?? 0
    }

    if (options.dryRun) {
      console.log(`[dry-run] Total: would delete ${totalDeleted} parts`)
      return { deletedParts: 0 }
    }

    // Step 3: Run VACUUM + TRUNCATE checkpoint
    const beforeSize = statSync(dbPath).size
    db.run("VACUUM")
    db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    const afterSize = statSync(dbPath).size
    const freedBytes = beforeSize - afterSize

    console.log(`Deleted ${totalDeleted} parts, freed ${formatBytes(freedBytes)} after VACUUM`)

    return { deletedParts: totalDeleted }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// CLI Subcommands
// ---------------------------------------------------------------------------

const QueryCommand = cmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: async (args: { query?: string; format: string }) => {
    const query = args.query as string | undefined
    if (query) {
      const db = new BunDatabase(Database.getPath(), { readonly: true })
      try {
        const result = db.query(query).all() as Record<string, unknown>[]
        if (args.format === "json") {
          console.log(JSON.stringify(result, null, 2))
        } else if (result.length > 0) {
          const keys = Object.keys(result[0])
          console.log(keys.join("\t"))
          for (const row of result) {
            console.log(keys.map((k) => row[k]).join("\t"))
          }
        }
      } catch (err) {
        UI.error(errorMessage(err))
        process.exit(1)
      }
      db.close()
      return
    }
    const child = spawn("sqlite3", [Database.getPath()], {
      stdio: "inherit",
    })
    await new Promise((resolve) => child.on("close", resolve))
  },
})

const PathCommand = cmd({
  command: "path",
  describe: "print the database path",
  handler: () => {
    console.log(Database.getPath())
  },
})

const MigrateCommand = cmd({
  command: "migrate",
  describe: "migrate JSON data to SQLite (merges with existing data)",
  handler: async () => {
    const sqlite = new BunDatabase(Database.getPath())
    const tty = process.stderr.isTTY
    const width = 36
    const orange = "\x1b[38;5;214m"
    const muted = "\x1b[0;2m"
    const reset = "\x1b[0m"
    let last = -1
    if (tty) process.stderr.write("\x1b[?25l")
    try {
      const stats = await JsonMigration.run(drizzle({ client: sqlite }), {
        progress: (event) => {
          const percent = Math.floor((event.current / event.total) * 100)
          if (percent === last) return
          last = percent
          if (tty) {
            const fill = Math.round((percent / 100) * width)
            const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
            process.stderr.write(
              `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.current}/${event.total}${reset} `,
            )
          } else {
            process.stderr.write(`sqlite-migration:${percent}${EOL}`)
          }
        },
      })
      if (tty) process.stderr.write("\n")
      if (tty) process.stderr.write("\x1b[?25h")
      else process.stderr.write(`sqlite-migration:done${EOL}`)
      UI.println(
        `Migration complete: ${stats.projects} projects, ${stats.sessions} sessions, ${stats.messages} messages`,
      )
      if (stats.errors.length > 0) {
        UI.println(`${stats.errors.length} errors occurred during migration`)
      }
    } catch (err) {
      if (tty) process.stderr.write("\x1b[?25h")
      UI.error(`Migration failed: ${errorMessage(err)}`)
      process.exit(1)
    } finally {
      sqlite.close()
    }
  },
})

const VacuumCommand = cmd({
  command: "vacuum",
  describe: "reclaim unused space by rebuilding the database file",
  handler: () => {
    const dbPath = Database.getPath()
    try {
      const { freedBytes } = runVacuum(dbPath)
      const sizeAfter = statSync(dbPath).size
      const sizeBefore = sizeAfter + freedBytes
      UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}Vacuum complete${UI.Style.TEXT_NORMAL}`)
      if (freedBytes > 0) {
        UI.println(
          `Freed ${formatBytes(freedBytes)} (${formatBytes(sizeBefore)} → ${formatBytes(sizeAfter)})`,
        )
      } else {
        UI.println(`No space reclaimed (database was already optimized)`)
      }
    } catch (err) {
      UI.error(`Vacuum failed: ${errorMessage(err)}`)
      process.exit(1)
    }
  },
})

const CheckpointCommand = cmd({
  command: "checkpoint",
  describe: "truncate the WAL journal file",
  handler: () => {
    const dbPath = Database.getPath()
    try {
      runCheckpoint(dbPath)
      UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}WAL checkpoint complete${UI.Style.TEXT_NORMAL}`)
    } catch (err) {
      UI.error(`Checkpoint failed: ${errorMessage(err)}`)
      process.exit(1)
    }
  },
})

const StatsCommand = cmd({
  command: "stats",
  describe: "show database statistics and vacuum recommendations",
  handler: () => {
    const dbPath = Database.getPath()
    try {
      runStats(dbPath)
    } catch (err) {
      UI.error(`Stats failed: ${errorMessage(err)}`)
      process.exit(1)
    }
  },
})

const CompactCommand = cmd({
  command: "compact",
  describe: "delete compacted and old tool call parts, then vacuum",
  builder: (yargs: Argv) => {
    return yargs
      .option("older-than", {
        type: "string",
        default: "90d",
        describe: "Age threshold (e.g. 90d, 30d)",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "Show what would be deleted without actually deleting",
      })
  },
  handler: (args: { olderThan: string; dryRun: boolean }) => {
    const dbPath = Database.getPath()
    try {
      runCompact(dbPath, { dryRun: args.dryRun, olderThan: args.olderThan })
    } catch (err) {
      UI.error(`Compact failed: ${errorMessage(err)}`)
      process.exit(1)
    }
  },
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs
      .command(QueryCommand)
      .command(PathCommand)
      .command(MigrateCommand)
      .command(VacuumCommand)
      .command(CheckpointCommand)
      .command(StatsCommand)
      .command(CompactCommand)
      .demandCommand()
  },
  handler: () => {},
})

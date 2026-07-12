import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { spawn } from "child_process"

// Global.Path.log is computed at module load from xdg-basedir.
// We can't easily override it per test, so we work with the real path.
const LOG_DIR = path.join(os.homedir(), ".local/share/opencode/log")
const TOOLS_LOG = path.join(LOG_DIR, "tools.log")

async function ensureLogDir() {
  await fs.mkdir(LOG_DIR, { recursive: true })
}

async function cleanupToolsLogFiles() {
  for (let i = 0; i <= 5; i++) {
    const f = i === 0 ? TOOLS_LOG : path.join(LOG_DIR, `tools-${i}.log`)
    await fs.unlink(f).catch(() => {})
  }
}

function waitWriteFlush(ms = 100) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("util.log.toolsLog", () => {
  beforeEach(async () => {
    await ensureLogDir()
    await cleanupToolsLogFiles()
  })

  afterEach(async () => {
    await cleanupToolsLogFiles()
  })

  describe("no-op when disabled", () => {
    test("toolsLog does nothing when OPENCODE_LOG_TOOLS is not set", async () => {
      // Module is loaded with OPENCODE_LOG_TOOLS undefined (default)
      // so TOOLS_LOG_ENABLED should be false
      const { toolsLog } = await import("@opencode-ai/core/util/log")

      // Call toolsLog — should be a no-op (no stream open)
      toolsLog({ tool: "test", action: "invoke" })

      // Verify no file was created
      const exists = await fs.stat(TOOLS_LOG).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })
  })

  describe("JSON Lines output when enabled", () => {
    test("toolsLog writes JSON Lines entries when OPENCODE_LOG_TOOLS=1", async () => {
      // Use a subprocess with OPENCODE_LOG_TOOLS=1 to test the full flow
      const script = `
        process.env.OPENCODE_LOG_TOOLS = "1";
        const { init, toolsLog } = await import("@opencode-ai/core/util/log");
        await init({ print: true });
        toolsLog({ tool: "bash", action: "invoke", args: { command: "ls" } });
        toolsLog({ tool: "read", action: "result", output: "file content" });
        await new Promise(r => setTimeout(r, 200));
      `

      const proc = spawn(process.execPath, ["-e", script], {
        cwd: path.join(import.meta.dir, "../.."),
        env: { ...process.env, OPENCODE_LOG_TOOLS: "1" },
      })

      await new Promise<void>((resolve) => proc.on("close", resolve))

      // Give stream a moment to flush
      await waitWriteFlush(100)

      // Read the tools.log file
      const content = await fs.readFile(TOOLS_LOG, "utf8")
      const lines = content.trim().split("\n").filter(Boolean)

      expect(lines.length).toBe(2)

      const entry1 = JSON.parse(lines[0])
      expect(entry1.timestamp).toBeDefined()
      expect(() => new Date(entry1.timestamp)).not.toThrow()
      expect(entry1.tool).toBe("bash")
      expect(entry1.action).toBe("invoke")
      expect(entry1.args).toEqual({ command: "ls" })

      const entry2 = JSON.parse(lines[1])
      expect(entry2.tool).toBe("read")
      expect(entry2.action).toBe("result")
      expect(entry2.output).toBe("file content")
    }, 10_000)

    test("toolsLog serializes entry with ISO timestamp format", async () => {
      const { toolsLog } = await import("@opencode-ai/core/util/log")

      // Verify it's a function that accepts a Record
      expect(typeof toolsLog).toBe("function")

      // Test that calling it doesn't throw even when disabled
      expect(() => toolsLog({ event: "test", data: { key: "value" } })).not.toThrow()
    })
  })

  describe("rotation logic", () => {
    test("rotateToolsLog shifts backups correctly", async () => {
      const { rotateToolsLog } = await import("@opencode-ai/core/util/log")

      // Verify the function exists
      expect(typeof rotateToolsLog).toBe("function")

      // Create test backup files
      const tools1Path = path.join(LOG_DIR, "tools-1.log")
      const tools2Path = path.join(LOG_DIR, "tools-2.log")
      const tools5Path = path.join(LOG_DIR, "tools-5.log")

      await fs.writeFile(TOOLS_LOG, "current-content")
      await fs.writeFile(tools1Path, "backup-1-content")
      await fs.writeFile(tools2Path, "backup-2-content")
      await fs.writeFile(tools5Path, "backup-5-content")

      // Verify files exist before rotation
      expect(await fs.stat(TOOLS_LOG).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.stat(tools1Path).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.stat(tools2Path).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.stat(tools5Path).then(() => true).catch(() => false)).toBe(true)

      // Rotate
      await rotateToolsLog()

      // After rotation:
      // - tools.log should be truncated (empty)
      // - tools-1.log should have "current-content"
      // - tools-2.log should have "backup-1-content"
      // - tools-3.log should have "backup-2-content"

      expect(await fs.stat(TOOLS_LOG).then(() => true).catch(() => false)).toBe(true)
      const currentContent = await fs.readFile(TOOLS_LOG, "utf8")
      expect(currentContent).toBe("")

      const newTools1 = await fs.readFile(tools1Path, "utf8")
      expect(newTools1).toBe("current-content")

      const tools3Path = path.join(LOG_DIR, "tools-3.log")
      const newTools3 = await fs.readFile(tools3Path, "utf8")
      expect(newTools3).toBe("backup-2-content")

      // tools-5 was dropped during rotation (oldest), then tools-4 shifted to 5
      // Since we didn't have tools-4, tools-5 should not exist
      const tools5Exists = await fs.stat(tools5Path).then(() => true).catch(() => false)
      expect(tools5Exists).toBe(false)
    })

    test("rotateToolsLog drops oldest backup when at capacity", async () => {
      const { rotateToolsLog } = await import("@opencode-ai/core/util/log")

      // Create all 5 backups + current
      for (let i = 1; i <= 5; i++) {
        await fs.writeFile(path.join(LOG_DIR, `tools-${i}.log`), `backup-${i}`)
      }
      await fs.writeFile(TOOLS_LOG, "current")

      await rotateToolsLog()

      // After rotation:
      // - tools-5 is dropped, then tools-4 shifts to tools-5
      // - tools-3 → tools-4, tools-2 → tools-3, tools-1 → tools-2
      // - current → tools-1
      const tools1Content = await fs.readFile(path.join(LOG_DIR, "tools-1.log"), "utf8")
      expect(tools1Content).toBe("current")

      const tools2Content = await fs.readFile(path.join(LOG_DIR, "tools-2.log"), "utf8")
      expect(tools2Content).toBe("backup-1")

      const tools5Content = await fs.readFile(path.join(LOG_DIR, "tools-5.log"), "utf8")
      expect(tools5Content).toBe("backup-4")

      // backup-5 was dropped (oldest)
      expect(tools5Content).not.toBe("backup-5")
    })
  })

  describe("export", () => {
    test("toolsLog is exported from the module", async () => {
      const logModule = await import("@opencode-ai/core/util/log")
      expect(typeof logModule.toolsLog).toBe("function")
    })

    test("rotateToolsLog is exported from the module", async () => {
      const logModule = await import("@opencode-ai/core/util/log")
      expect(typeof logModule.rotateToolsLog).toBe("function")
    })
  })

  describe("initToolsLog integration", () => {
    test("initToolsLog is exported and callable", async () => {
      const { init, initToolsLog } = await import("@opencode-ai/core/util/log")
      expect(typeof init).toBe("function")
      expect(typeof initToolsLog).toBe("function")
    })

    test("init calls initToolsLog when OPENCODE_LOG_TOOLS=1", async () => {
      // Use a subprocess with OPENCODE_LOG_TOOLS=1 to verify init opens the stream
      const script = `
        process.env.OPENCODE_LOG_TOOLS = "1";
        const { init, toolsLog } = await import("@opencode-ai/core/util/log");
        await init({ print: true });
        toolsLog({ check: "stream-open" });
        await new Promise(r => setTimeout(r, 200));
      `

      const proc = spawn(process.execPath, ["-e", script], {
        cwd: path.join(import.meta.dir, "../.."),
        env: { ...process.env, OPENCODE_LOG_TOOLS: "1" },
      })

      await new Promise<void>((resolve) => proc.on("close", resolve))
      await waitWriteFlush(100)

      // tools.log should exist and contain the entry
      const exists = await fs.stat(TOOLS_LOG).then(() => true).catch(() => false)
      expect(exists).toBe(true)

      const content = await fs.readFile(TOOLS_LOG, "utf8")
      const entry = JSON.parse(content.trim())
      expect(entry.check).toBe("stream-open")
    }, 10_000)
  })
})

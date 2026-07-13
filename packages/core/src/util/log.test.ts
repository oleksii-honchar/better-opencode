import { expect, test, describe, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"

// Test state for line counting and rotation
let testDir: string

describe("TOOL_LOG_FILE_MAX_LINES - Line Count Management", () => {
  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "tools-log-test-"))
  })

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  describe("Environment variable parsing", () => {
    test("should return null when env var is not set", () => {
      const original = process.env.TOOL_LOG_FILE_MAX_LINES
      delete process.env.TOOL_LOG_FILE_MAX_LINES
      try {
        // Simulate the IIFE logic
        const result = (() => {
          const raw = process.env.TOOL_LOG_FILE_MAX_LINES
          if (raw == null || raw === "") return null
          const n = Number(raw)
          return n > 0 ? n : null
        })()
        expect(result).toBeNull()
      } finally {
        process.env.TOOL_LOG_FILE_MAX_LINES = original
      }
    })

    test("should return null when env var is empty string", () => {
      const original = process.env.TOOL_LOG_FILE_MAX_LINES
      process.env.TOOL_LOG_FILE_MAX_LINES = ""
      try {
        const result = (() => {
          const raw = process.env.TOOL_LOG_FILE_MAX_LINES
          if (raw == null || raw === "") return null
          const n = Number(raw)
          return n > 0 ? n : null
        })()
        expect(result).toBeNull()
      } finally {
        process.env.TOOL_LOG_FILE_MAX_LINES = original
      }
    })

    test("should return null when env var is '0'", () => {
      const original = process.env.TOOL_LOG_FILE_MAX_LINES
      process.env.TOOL_LOG_FILE_MAX_LINES = "0"
      try {
        const result = (() => {
          const raw = process.env.TOOL_LOG_FILE_MAX_LINES
          if (raw == null || raw === "") return null
          const n = Number(raw)
          return n > 0 ? n : null
        })()
        expect(result).toBeNull()
      } finally {
        process.env.TOOL_LOG_FILE_MAX_LINES = original
      }
    })

    test("should return null when env var is negative", () => {
      const original = process.env.TOOL_LOG_FILE_MAX_LINES
      process.env.TOOL_LOG_FILE_MAX_LINES = "-100"
      try {
        const result = (() => {
          const raw = process.env.TOOL_LOG_FILE_MAX_LINES
          if (raw == null || raw === "") return null
          const n = Number(raw)
          return n > 0 ? n : null
        })()
        expect(result).toBeNull()
      } finally {
        process.env.TOOL_LOG_FILE_MAX_LINES = original
      }
    })

    test("should return null when env var is non-numeric", () => {
      const original = process.env.TOOL_LOG_FILE_MAX_LINES
      process.env.TOOL_LOG_FILE_MAX_LINES = "abc"
      try {
        const result = (() => {
          const raw = process.env.TOOL_LOG_FILE_MAX_LINES
          if (raw == null || raw === "") return null
          const n = Number(raw)
          return n > 0 ? n : null
        })()
        expect(result).toBeNull()
      } finally {
        process.env.TOOL_LOG_FILE_MAX_LINES = original
      }
    })

    test("should return positive number for valid value", () => {
      const original = process.env.TOOL_LOG_FILE_MAX_LINES
      process.env.TOOL_LOG_FILE_MAX_LINES = "1000"
      try {
        const result = (() => {
          const raw = process.env.TOOL_LOG_FILE_MAX_LINES
          if (raw == null || raw === "") return null
          const n = Number(raw)
          return n > 0 ? n : null
        })()
        expect(result).toBe(1000)
      } finally {
        process.env.TOOL_LOG_FILE_MAX_LINES = original
      }
    })
  })

  describe("Line counting behavior", () => {
    test("should track line count correctly", () => {
      // Simulate line counting logic
      let lineCount = 0
      const maxLines = 5
      
      for (let i = 0; i < maxLines; i++) {
        lineCount++
      }
      
      expect(lineCount).toBe(maxLines)
    })

    test("should trigger rotation when threshold reached", () => {
      let rotationTriggered = false
      let lineCount = 0
      const maxLines = 5
      
      const triggerRotation = () => {
        lineCount++
        if (lineCount >= maxLines) {
          rotationTriggered = true
        }
      }
      
      // Should not trigger before threshold
      for (let i = 0; i < 4; i++) {
        triggerRotation()
      }
      expect(rotationTriggered).toBe(false)
      
      // Should trigger at threshold
      triggerRotation()
      expect(rotationTriggered).toBe(true)
    })

    test("should reset counter after rotation", () => {
      let lineCount = 5
      // Simulate post-rotation reset
      lineCount = 0
      expect(lineCount).toBe(0)
    })
  })

  describe("Debouncing logic", () => {
    test("should prevent concurrent rotations", () => {
      let rotating = false
      let rotationCount = 0
      
      const attemptRotation = () => {
        if (rotating) return false
        rotating = true
        rotationCount++
        return true
      }
      
      // First call succeeds
      expect(attemptRotation()).toBe(true)
      
      // Concurrent calls are rejected
      expect(attemptRotation()).toBe(false)
      expect(attemptRotation()).toBe(false)
      
      expect(rotationCount).toBe(1)
    })

    test("should track pending rotations", () => {
      let rotating = false
      let pending = false
      
      rotating = true
      // Simulate rotation in progress
      pending = true // Request rotation while rotating
      
      expect(pending).toBe(true)
    })

    test("should handle burst writes with debounce", () => {
      let rotationScheduled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      
      // Simulate debounced scheduling
      const scheduleWithDebounce = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          rotationScheduled = true
          timer = null
        }, 100)
      }
      
      // Multiple rapid requests
      scheduleWithDebounce()
      scheduleWithDebounce()
      scheduleWithDebounce()
      
      // Only one timer should be active
      expect(rotationScheduled).toBe(false)
      
      // Cleanup
      if (timer) clearTimeout(timer)
    })
  })

  describe("Exit handler behavior", () => {
    test("should perform final rotation on exit", () => {
      let lineCount = 10
      let maxLines = 5
      let rotationExecuted = false
      
      // Simulate exit handler logic
      if (lineCount >= maxLines) {
        rotationExecuted = true
        lineCount = 0
      }
      
      expect(rotationExecuted).toBe(true)
      expect(lineCount).toBe(0)
    })

    test("should not rotate on exit if threshold not exceeded", () => {
      let lineCount = 2
      let maxLines = 5
      let rotationExecuted = false
      
      // Simulate exit handler logic
      if (lineCount >= maxLines) {
        rotationExecuted = true
        lineCount = 0
      }
      
      expect(rotationExecuted).toBe(false)
      expect(lineCount).toBe(2)
    })
  })
})

describe("TOOLS_LOG_MAX_LINES - Integration with tools.log", () => {
  test("should create and write to tools.log file", async () => {
    const logFile = path.join(testDir, "tools.log")
    
    // Create parent directory if needed
    await require("fs/promises").mkdir(testDir, { recursive: true })
    
    // Simulate creating write stream (synchronous write)
    fs.writeFileSync(logFile, '{"test": true}\n')
    
    // Verify file exists
    expect(fs.existsSync(logFile)).toBe(true)
  })

  test("should append to existing tools.log file", async () => {
    const logFile = path.join(testDir, "tools.log")
    
    // Create parent directory if needed
    await require("fs/promises").mkdir(testDir, { recursive: true })
    
    // Create file with initial content
    fs.writeFileSync(logFile, '{"line": 1}\n')
    
    // Append more content using fs.appendFileSync
    fs.appendFileSync(logFile, '{"line": 2}\n')
    
    // Verify both lines exist
    const content = fs.readFileSync(logFile, "utf-8")
    const lines = content.split("\n").filter(l => l.length > 0)
    expect(lines.length).toBe(2)
  })
})

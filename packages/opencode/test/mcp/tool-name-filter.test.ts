/**
 * Tests for the prefix-tolerant MCP tool-name matcher.
 *
 * Semantics (spec §3): for each config entry `P` and tool name `T`,
 * `toolNameMatches(T, [P])` is true iff `T === P` (exact, backward
 * compatible) OR `T` equals `P` preceded by any non-empty prefix
 * terminated by one of `-`, `_`, `.`.
 */

import { describe, expect, test } from "bun:test"
import { toolNameMatches } from "../../src/mcp/tool-name-filter"

describe("toolNameMatches", () => {
  test("exact match", () => {
    expect(toolNameMatches("recallMemory", ["recallMemory"])).toBe(true)
  })

  test("hyphen-prefixed match", () => {
    expect(toolNameMatches("bensyne-recallMemory", ["recallMemory"])).toBe(true)
  })

  test("underscore-prefixed match", () => {
    expect(toolNameMatches("bensyne_recallMemory", ["recallMemory"])).toBe(true)
  })

  test("dot-prefixed match", () => {
    expect(toolNameMatches("bensyne.recallMemory", ["recallMemory"])).toBe(true)
  })

  test("suffix mismatch is rejected", () => {
    expect(toolNameMatches("bensyne-recallMemoryX", ["recallMemory"])).toBe(false)
  })

  test("prefix not terminated by a separator is rejected", () => {
    expect(toolNameMatches("bensyneXrecallMemory", ["recallMemory"])).toBe(false)
  })

  test("tool not in the list is rejected", () => {
    expect(toolNameMatches("bensyne-forgetFile", ["recallMemory", "rememberMemory"])).toBe(false)
  })

  test("existing prefixed config entries still match exactly", () => {
    expect(toolNameMatches("paperless-list_documents", ["paperless-list_documents"])).toBe(true)
  })

  test("regex-metacharacter entries match exactly without regex injection", () => {
    expect(toolNameMatches("a.b-c_d", ["a.b-c_d"])).toBe(true)
  })

  test("regex-metacharacter entries match via prefixed variants", () => {
    expect(toolNameMatches("server-a.b-c_d", ["a.b-c_d"])).toBe(true)
    expect(toolNameMatches("server_a.b-c_d", ["a.b-c_d"])).toBe(true)
    expect(toolNameMatches("server.a.b-c_d", ["a.b-c_d"])).toBe(true)
  })

  test("regex-metacharacter entries do not over-match similar names", () => {
    // "a.b-c_d" must not match a name where the dots/dashes sit elsewhere
    expect(toolNameMatches("aXb-c_d", ["a.b-c_d"])).toBe(false)
    expect(toolNameMatches("a.b-cXd", ["a.b-c_d"])).toBe(false)
  })

  test("empty names list never matches", () => {
    expect(toolNameMatches("recallMemory", [])).toBe(false)
    expect(toolNameMatches("bensyne-recallMemory", [])).toBe(false)
    expect(toolNameMatches("", [])).toBe(false)
  })

  test("empty tool name never matches a non-empty entry", () => {
    expect(toolNameMatches("", ["x"])).toBe(false)
  })

  test("full bensyne 15-entry scenario: every allowed tool matches its bensyne- prefixed variant", () => {
    const allowed = [
      "recallMemory",
      "rememberMemory",
      "forgetMemory",
      "updateMemory",
      "sleep",
      "getMemoryStats",
      "listMemoryBanks",
      "registerMemoryBank",
      "searchFiles",
      "expandFileRelations",
      "fetchFile",
      "getFileChunks",
      "getPersonaStatus",
      "getPersonaEntryNode",
      "searchMemoryBank",
    ]
    for (const name of allowed) {
      expect(toolNameMatches(`bensyne-${name}`, allowed)).toBe(true)
      expect(toolNameMatches(name, allowed)).toBe(true)
    }
    // "forgetFile" is intentionally omitted from the allowlist
    expect(toolNameMatches("bensyne-forgetFile", allowed)).toBe(false)
  })

  test("blacklist parity: a blacklisted base name also disables its prefixed variants", () => {
    const disabled = ["forgetMemory"]
    expect(toolNameMatches("bensyne-forgetMemory", disabled)).toBe(true)
    expect(toolNameMatches("forgetMemory", disabled)).toBe(true)
    expect(toolNameMatches("bensyne-rememberMemory", disabled)).toBe(false)
  })
})
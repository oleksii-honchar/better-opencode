import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { deriveSubagentSessionPermission } from "./subagent-permissions"
import type { Permission } from "../permission"

// Mirror of comfyui-troubleshooter.md frontmatter permission.external_directory
const agentExternalRules: Permission.Ruleset = [
  { permission: "external_directory", pattern: "*", action: "ask" },
  { permission: "external_directory", pattern: "/Users/tuiteraz/*", action: "allow" },
  { permission: "external_directory", pattern: "/Volumes/Data/www/*", action: "allow" },
  { permission: "external_directory", pattern: "/Volumes/Data/TMP/*", action: "allow" },
  { permission: "external_directory", pattern: "/tmp/*", action: "allow" },
  { permission: "external_directory", pattern: "/var/*/opencode/*", action: "allow" },
]

const FLUX_PATTERN = "/Volumes/Data/www/beaver/behemoth-lan/comfyui/workflows/flux2/*"

// Minimal structural type: only the fields deriveSubagentSessionPermission reads.
const subagent = {
  name: "comfyui-troubleshooter",
  permission: agentExternalRules,
} as unknown as Parameters<typeof deriveSubagentSessionPermission>[0]["subagent"]

const evaluateAtAskTime = (sessionPermission: Permission.Ruleset) => {
  const sessionRules = deriveSubagentSessionPermission({
    parentSessionPermission: sessionPermission,
    parentAgent: undefined,
    subagent,
  })
  // tools.ts:270 — ask-time ruleset = merge(agent.permission, session.permission) → agent rules first, session rules last
  const merged = PermissionV2.merge(agentExternalRules, sessionRules)
  return PermissionV2.evaluate("external_directory", FLUX_PATTERN, merged)
}

describe("flux2 permission ask simulation", () => {
  test("Case A: parent session carries no external *:ask → allow wins (no prompt)", () => {
    const rule = evaluateAtAskTime([])
    expect(rule.action).toBe("allow")
  })

  test("Case B: parent session carries external *:ask → fix still resolves allow (no prompt)", () => {
    const parentSession: Permission.Ruleset = [
      { permission: "external_directory", pattern: "*", action: "ask" },
    ]
    const rule = evaluateAtAskTime(parentSession)
    // With the fix, the subagent's own allows are forwarded AFTER the parent's
    // *:ask in the derived session rules, so findLast picks the allow.
    expect(rule.action).toBe("allow")
  })
})
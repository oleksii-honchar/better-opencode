import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { Permission } from "@/permission"
import { ConfigPermission } from "./permission"

// The permission config schema (ConfigPermission.Info) is a decodeTo transform
// whose target is the "InputObject" StructWithRest. Known permission keys are the
// declared fields on that struct; unknown keys are tolerated via the rest record.
type PropertySignatureLike = { name: string }
type InputObjectLike = { to: { ast: { propertySignatures: readonly PropertySignatureLike[] } } }

const knownPermissionKeys = () =>
  (ConfigPermission.Info as unknown as InputObjectLike).to.ast.propertySignatures.map((p) => p.name)

describe("Permission Schema — switch_model key (C6)", () => {
  test("switch_model is a declared known permission key", () => {
    // Mirrors how other tool permission keys (edit, bash, ...) are declared.
    expect(knownPermissionKeys()).toContain("switch_model")
  })

  test("switch_model resolves to its default allow policy when unset in permissions", () => {
    // An unset permission key falls back to the agent's default ruleset. The
    // default (build) agent allows all tools via the "*" wildcard rule, so a
    // switch_model request with no configured rule resolves to "allow".
    const defaults = Permission.fromConfig({ "*": "allow" })
    const rule = Permission.evaluate("switch_model", "*", defaults)
    expect(rule.action).toBe("allow")
  })

  test("switch_model accepts an Action shorthand value", () => {
    const parsed = Schema.decodeUnknownSync(ConfigPermission.Info)({ switch_model: "allow" })
    expect(parsed).toMatchObject({ switch_model: "allow" })
  })

  test("switch_model accepts an Object (per-target) rule", () => {
    const parsed = Schema.decodeUnknownSync(ConfigPermission.Info)({
      switch_model: { "*": "ask" },
    })
    expect(parsed).toMatchObject({ switch_model: { "*": "ask" } })
  })

  test("existing permission config without switch_model still decodes (backward compatible)", () => {
    // Additive only: pre-existing permission keys are preserved and an absent
    // switch_model stays undefined — old configs load unchanged.
    const parsed = Schema.decodeUnknownSync(ConfigPermission.Info)({
      edit: "ask",
      bash: "allow",
    })
    expect(parsed).toMatchObject({ edit: "ask", bash: "allow" })
    expect(parsed.switch_model).toBeUndefined()
  })
})

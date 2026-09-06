import type { Permission } from "../permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent **agent's** edit-class deny rules — Plan Mode's file-edit
 *    restriction lives on the agent ruleset, not on the session, so a
 *    subagent that only inherited the parent SESSION's permission would
 *    silently bypass it. (#26514)
 * 2. The parent **session's** deny rules and external_directory rules —
 *    same forwarding the original code already did.
 * 3. The **subagent's own** external_directory allow rules — agent-file
 *    permission grants (e.g. `/Volumes/Data/www/*: allow`) are otherwise
 *    dropped when a subagent is task-spawned, which causes repeated
 *    external_directory permission prompts for paths the subagent is
 *    supposed to be trusted for. Placed AFTER the parent session's
 *    external_directory rules so a parent default `*: ask` does NOT override
 *    the subagent allow (findLast semantics), but BEFORE any parent deny
 *    rules so explicit denies still win.
 * 4. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: Permission.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): Permission.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const parentAgentDenies =
    input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? []
  const subagentExternalAllows = input.subagent.permission.filter(
    (rule) => rule.permission === "external_directory" && rule.action === "allow",
  )
  const parentExternalAndDenies = input.parentSessionPermission.filter(
    (rule) => rule.permission === "external_directory" || rule.action === "deny",
  )
  const [parentExternal, parentDenies] = [
    parentExternalAndDenies.filter((rule) => rule.permission === "external_directory"),
    parentExternalAndDenies.filter((rule) => rule.action === "deny"),
  ]
  return [
    ...parentAgentDenies,
    ...parentExternal,
    ...subagentExternalAllows,
    ...parentDenies,
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

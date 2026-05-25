import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceID } from "@/control-plane/schema"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~opencode/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceID | undefined>("~opencode/WorkspaceRef", {
  defaultValue: () => undefined,
})

/**
 * Per-request workspace folders from the session.
 * Used by Agent.state to build external_directory whitelistedDirs.
 * Unlike InstanceContext.workspaceFolders (cached per directory), this is
 * set per-request by the middleware and always reflects the current session.
 */
export const WorkspaceFoldersRef = Context.Reference<string[] | undefined>("~opencode/WorkspaceFoldersRef", {
  defaultValue: () => undefined,
})

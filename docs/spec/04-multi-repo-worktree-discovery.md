---
feature: multi-repo-worktree-discovery
version: 1.0.0
status: spec
source: new feature proposal
pr: N/A
implementation: pending
---

# Spec: Multi-Repo Worktree Discovery in System Prompt

## Implementation Status

| Status | Description |
|--------|-------------|
| **Status** | ⏳ **Pending** — New feature, not yet implemented |
| **Source** | New feature proposal |
| **Next Step** | Design and implement worktree discovery in `<env>` block |

## Problem Statement

**Primary Problem: The agent has no list of known working directories, forcing it to use expensive `find *` global search calls** to discover files and repos in the workspace.

**Secondary Problems:**
In multi-repo and monorepo environments with complex navigation structures, the agent only knows about the current working directory and worktree in the `<env>` block. When the agent navigates to different directories or works across multiple git repositories, it lacks awareness of:

1. **Sibling repositories** — other git repos in the same parent directory
2. **Nested repositories** — git repos nested within the current worktree
3. **Related worktrees** — other worktrees associated with the same project (git worktrees)
4. **Project hierarchy** — the relationship between nested repos

This causes issues when:
- The agent needs to reference files in sibling repos
- The agent tries to edit files in nested repos without knowing they're separate git repos
- The agent performs git operations assuming a single repo context
- Multi-repo workflows require cross-repo coordination
- The agent makes `find *` calls to discover files instead of using known directory paths

## Design Decision

**Discover and enumerate all known git repositories in the `<env>` block, categorized by relationship to the current context.**

**Rationale:**
- **Eliminates `find *` global searches** — agent has a list of known working directories to check
- Provides the agent with full awareness of the repository landscape
- Enables intelligent navigation and file access across repo boundaries
- Works with existing `Instance.sandboxes` data structure in `Project.Info`
- Minimal performance impact — discovery runs once at session start
- Survives compaction (system prompt is rebuilt each turn)

## Files Modified

| File | Lines Added | Lines Removed |
|------|-------------|---------------|
| `packages/opencode/src/session/system.ts` | +20 | 0 |
| `packages/opencode/src/project/project.ts` | +10 (new helper) | 0 |

## Implementation Details

### 1. `packages/opencode/src/project/project.ts` — Add worktree discovery helper

**Add helper function** to discover related repositories:

```typescript
/**
 * Discover all git repositories related to the given directory.
 * Returns a list of worktrees with their relationship to the current context.
 */
function discoverRelatedWorktrees(directory: string): Array<{
  path: string
  isCurrent: boolean
  isNested: boolean
  isSibling: boolean
  isWorktree: boolean
  vcs: string
}> {
  const results: Array<{
    path: string
    isCurrent: boolean
    isNested: boolean
    isSibling: boolean
    isWorktree: boolean
    vcs: string
  }> = []

  // Add current worktree
  const currentWorktree = Instance.worktree
  results.push({
    path: currentWorktree,
    isCurrent: true,
    isNested: false,
    isSibling: false,
    isWorktree: false,
    vcs: "git",
  })

  // Discover nested repos (git repos inside current worktree)
  // Discover sibling repos (git repos in parent directories)
  // Discover git worktrees (shared git dir, different worktrees)

  return results
}
```

### 2. `packages/opencode/src/session/system.ts` — Add worktree info to `<env>` block

**Modify the `environment()` method** to include worktree discovery:

```typescript
environment(model, sessionID, parentSessionID) {
  const project = Instance.project
  const worktreeEntries = discoverRelatedWorktrees(Instance.directory)

  // Build worktree lines
  const worktreeLines = worktreeEntries.map((entry) => {
    const prefix = entry.isCurrent ? "▶" : "  "
    const suffix = entry.isWorktree ? " (worktree)" : entry.isNested ? " (nested)" : ""
    return `${prefix}  ${entry.path}${suffix}`
  })

  return [
    [
      `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${Instance.directory}`,
      `  Workspace root folder: ${Instance.worktree}`,
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      ...(sessionID ? [`  Session ID: ${sessionID}`] : []),
      ...(parentSessionID ? [`  Parent Session ID: ${parentSessionID}`] : []),
      `  Repositories:`,
      ...worktreeLines,
      `</env>`,
    ].join("\n"),
  ]
}
```

## System Prompt Output Example

### Single Repo
```
<env>
  Working directory: /Users/oleksii.honchar/project
  Workspace root folder: /Users/oleksii.honchar/project
  Is directory a git repo: yes
  Platform: darwin
  Today's date: Fri Apr 24 2026
  Session ID: ses_241c208c9ffeI6DgeZh6Qhu3sl
  Parent Session ID: ses_abc123def456
  Repositories:
  ▶  /Users/oleksii.honchar/project
</env>
```

### Multi-Repo (Sibling Repositories)
```
<env>
  Working directory: /Users/oleksii.honchar/workspace/my-app
  Workspace root folder: /Users/oleksii.honchar/workspace/my-app
  Is directory a git repo: yes
  Platform: darwin
  Today's date: Fri Apr 24 2026
  Session ID: ses_241c208c9ffeI6DgeZh6Qhu3sl
  Parent Session ID: ses_abc123def456
  Repositories:
  ▶  /Users/oleksii.honchar/workspace/my-app
    /Users/oleksii.honchar/workspace/other-app
    /Users/oleksii.honchar/workspace/shared-lib
</env>
```

### Monorepo with Nested Repos
```
<env>
  Working directory: /Users/oleksii.honchar/monorepo/packages/frontend
  Workspace root folder: /Users/oleksii.honchar/monorepo
  Is directory a git repo: yes
  Platform: darwin
  Today's date: Fri Apr 24 2026
  Session ID: ses_241c208c9ffeI6DgeZh6Qhu3sl
  Parent Session ID: ses_abc123def456
  Repositories:
  ▶  /Users/oleksii.honchar/monorepo
    /Users/oleksii.honchar/monorepo/packages/frontend (nested)
    /Users/oleksii.honchar/monorepo/packages/backend (nested)
</env>
```

### Git Worktrees
```
<env>
  Working directory: /Users/oleksii.honchar/project/feature-branch
  Workspace root folder: /Users/oleksii.honchar/project/feature-branch
  Is directory a git repo: yes
  Platform: darwin
  Today's date: Fri Apr 24 2026
  Session ID: ses_241c208c9ffeI6DgeZh6Qhu3sl
  Parent Session ID: ses_abc123def456
  Repositories:
  ▶  /Users/oleksii.honchar/project (main)
    /Users/oleksii.honchar/project/feature-branch (worktree)
</env>
```

## OpenChamber Impact Assessment

| File | Change Type | Impact |
|------|-------------|--------|
| `packages/opencode/src/session/system.ts` | Additional lines in `<env>` block | **None** — only adds information, doesn't change behavior |
| `packages/opencode/src/project/project.ts` | New helper function | **None** — not exported, internal use only |

**Risk Level:** Very Low

## Success Criteria

- [ ] System prompt includes `Repositories:` section in `<env>` block
- [ ] Current worktree is marked with `▶` indicator
- [ ] Nested repos are marked with `(nested)` suffix
- [ ] Worktrees are marked with `(worktree)` suffix
- [ ] Discovery completes within 100ms (performance constraint)
- [ ] Works correctly with git worktrees
- [ ] Works correctly with nested monorepos
- [ ] OpenChamber type-check passes
- [ ] OpenChamber build succeeds

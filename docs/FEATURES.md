# better-opencode Features

This document describes the four core features added by the `better-opencode` fork.

For an overview of the fork's purpose and installation, see [BETTER-OPENCODE.md](./BETTER-OPENCODE.md).

---

## 1. `tool.execute.after` Inject (PR #19519)

📋 [Detailed Spec](./spec/02-tool-execute-after-inject.md)

**Status:** ⏳ Pending — PR #19519 is unmerged upstream

Plugins can inject synthetic user messages after tool execution. These messages are persisted and visible to the AI on the next loop iteration.

**Example plugin:**
```typescript
// After every file edit, remind agent to update progress.md
"tool.execute.after": async (input, output) => {
  if (input.tool === "edit") {
    output.inject = [{
      type: "text",
      text: "<system-reminder>Remember: update progress.md after file changes.</system-reminder>"
    }];
  }
}
```

---

## 2. `session.stopping` Hook (PR #16598)

📋 [Detailed Spec](./spec/03-session-stopping-hook.md)

**Status:** ⏳ Pending — PR #16598 is unmerged upstream

Plugins can intercept the agent's idle/stop state and inject a follow-up message instead of stopping.

**Example plugin:**
```typescript
// Prevent agent from stopping if progress.md hasn't been updated
"session.stopping": async (input, output) => {
  if (input.reason === "idle") {
    const progressExists = await fileExists("progress.md");
    if (!progressExists) {
      output.continue = true;
      output.message = {
        type: "text",
        text: "<system-reminder>You haven't updated progress.md yet — continue working.</system-reminder>"
      };
    }
  }
}
```

---

## 3. Session ID in System Prompt

📋 [Detailed Spec](./spec/01-session-id-system-prompt.md)

**Status:** ⏳ Pending — Custom commit `50d0b4dcfd` exists on `patched/dev` branch but not yet applied

The current `sessionID` and `parentSessionID` are included in the system prompt `<env>` block on every LLM call. This survives compaction because the system prompt is rebuilt from scratch each turn.

**System prompt output:**
```
You are powered by the model named claude-sonnet-4. The exact model ID is anthropic/claude-sonnet-4
Here is some useful information about the environment you are running in:
<env>
  Working directory: /Users/oleksii.honchar/project
  Workspace root folder: /Users/oleksii.honchar/project
  Is directory a git repo: yes
  Platform: darwin
  Today's date: Fri Apr 24 2026
  Session ID: ses_241c208c9ffeI6DgeZh6Qhu3sl
  Parent Session ID: ses_abc123def456
</env>
```

---

## 4. Multi-Repo Worktree Discovery

📋 [Detailed Spec](./spec/04-multi-repo-worktree-discovery.md)

**Status:** ⏳ Pending — New feature proposal

**Main purpose:** Avoid expensive `find *` global search calls by giving the agent a list of known working directories upfront.

In multi-repo and monorepo environments, the agent discovers and enumerates all related git repositories in the `<env>` block. This enables intelligent navigation and file access across repo boundaries, including sibling repos, nested repos, and git worktrees.

**System prompt output (multi-repo example):**
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

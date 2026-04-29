# better-opencode

## Purpose

A maintained fork of [opencode](https://github.com/anomalyco/opencode) that patches critical gaps in the AI coding agent:

1. **Context loss after ~5 turns** — The agent forgets behavioral rules and workflow state after automatic compaction.
2. **Repetitive loops** — The agent gets stuck repeating the same actions without making progress.
3. **Session opacity** — The agent has no awareness of its own session ID, making debugging and multi-session coordination difficult.

This fork provides plugin hooks for behavioral enforcement and session awareness that survive compaction.

---

## Features

### 1. `tool.execute.after` Inject (PR #19519)

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

### 2. `session.stopping` Hook (PR #16598)

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

### 3. Session ID in System Prompt

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

## Installation

### Prerequisites

- **macOS** (Apple Silicon recommended)
- **Bun** 1.3.13+ — [Install](https://bun.sh/docs/installation)
- **Git** — for fetching and building

### Quick Install (Recommended)

```bash
# Clone the fork (if not already cloned)
cd ~/www/misc
git clone git@github.com:oleksii-honchar/better-opencode.git

# Build and install (automates everything)
cd better-opencode
./build-and-install.sh --install --clean
~/bin/better-opencode --version

```

This script will:
1. Fetch the latest upstream `dev` branch
2. Rebase `patched/dev` onto upstream
3. Run `bun install`, `bun turbo typecheck`, and `bun run build`
4. Install the forked binary to `~/bin/better-opencode`
5. Configure OpenChamber to use the forked binary

---

## Usage

### Using the Forked Binary

```bash
# Use the forked binary directly
~/bin/better-opencode <your-project>

# Or set in PATH
export PATH="$HOME/bin:$PATH"
better-opencode <your-project>
```

### Configuring OpenChamber

**Desktop app** — Add to `~/.config/openchamber/settings.json`:
```json
{
  "opencodeBinary": "/Users/oleksii.honchar/bin/better-opencode"
}
```

**CLI script** — Add to `~/.zshrc`:
```bash
export OPENCHAMBER_OPENCODE_PATH="/Users/oleksii.honchar/bin/better-opencode"
```

### Keeping the Fork Updated

```bash
cd ~/www/misc/better-opencode
git fetch upstream
git checkout patched/dev
git rebase upstream/dev --reapply-cherry-picks
./build-and-install.sh --install --clean
```

---

## Runbook: Making Changes and Syncing with Source

### Fork Structure

```
better-opencode/
├── upstream/          → anomalyco/opencode (upstream, read-only)
├── origin/            → oleksii-honchar/better-opencode (your fork, push target)
└── patched/dev        → your working branch (patches + synced with upstream)
```

### Syncing with Upstream (Staying Current)

**Before making any changes, always sync first:**

```bash
cd ~/www/misc/better-opencode

# 1. Fetch latest from both remotes
git fetch upstream dev --quiet
git fetch origin --quiet

# 2. Check divergence
git log --oneline patched/dev..upstream/dev | wc -l  # commits behind
git log --oneline upstream/dev..patched/dev | wc -l  # commits ahead

# 3. Rebase patched/dev onto upstream/dev
git checkout patched/dev
git rebase upstream/dev

# 4. If conflicts occur, resolve them:
#    git rebase --continue      (after resolving each conflict)
#    git rebase --abort         (to cancel)

# 5. Push rebased branch to your fork
git push origin patched/dev --force-with-lease
```

### Making Changes to the Fork

**Scenario 1: Adding a new patch/feature**

```bash
cd ~/www/misc/better-opencode
git checkout patched/dev

# Create a feature branch from patched/dev
git checkout -b feature/my-new-patch

# Make your changes...
# ...

# Commit and push
git add .
git commit -m "feat: describe your change"
git push origin feature/my-new-patch

# When ready to merge into patched/dev:
git checkout patched/dev
git merge feature/my-new-patch
git push origin patched/dev
```

**Scenario 2: Fixing a merge conflict after rebase**

```bash
# After git rebase upstream/dev fails:
git status  # shows conflicted files

# Resolve conflicts in each file, then:
git add <resolved-file>
git rebase --continue  # repeat until rebase completes
```

**Scenario 3: Temporarily switching to Homebrew opencode**

```bash
# Remove OpenChamber config (switch back to Homebrew)
./build-and-install.sh --unconfigure-openchamber

# When ready to switch back:
./build-and-install.sh --configure-openchamber
```

### Building and Testing

**Quick build (no install):**
```bash
./build-and-install.sh --only-build
```

**Full build + install:**
```bash
./build-and-install.sh --install --clean
```

**Verify the build:**
```bash
~/bin/better-opencode --version
~/bin/better-opencode --help
```

### Pushing Changes to GitHub

**After making local changes:**
```bash
cd ~/www/misc/better-opencode
git push origin patched/dev
```

**If you need to force push (after rebase):**
```bash
git push origin patched/dev --force-with-lease
```

### Recovery Scenarios

| Problem | Solution |
|---------|----------|
| Rebase fails with conflicts | `git rebase --abort` to reset, then resolve manually |
| Accidentally modified `patched/dev` | `git checkout patched/dev && git reset --hard upstream/dev` |
| Lost local changes | Check `git reflog` to recover |
| Fork is far behind upstream | Run sync steps above, resolve conflicts iteratively |

---

## Compatibility

This fork is **backward-compatible** with OpenChamber. All patches use optional parameters and fields — existing behavior is unchanged when hooks do not return `inject` or `continue`.

---

## Deferred Features

- **Docker packaging** — Multi-stage build for reproducible distribution (user requested to postpone)
- **Oh-my-openagent hash-edit tool** — Hash-anchored file editing for maximum precision (~500+ line project, deferred to Phase 5)

---

## License

MIT — Same as upstream opencode.

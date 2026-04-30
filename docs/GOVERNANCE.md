# better-opencode Governance

This document defines the governance procedures for maintaining the `better-opencode` fork — how to make changes, sync with upstream, build, and push.

For an overview of the fork's purpose and features, see [BETTER-OPENCODE.md](./BETTER-OPENCODE.md).

---

## Fork Structure

```
                    upstream/anomalyco/opencode
                    ┌─────────────────────────┐
                    │  dev (development)      │◀── current target
                    └─────────────────────────┘
                              │
                              │ fork
                              ▼
              oleksii-honchar/better-opencode (origin)
              ┌─────────────────────────────────────┐
              │  dev (mirrors upstream/dev)         │◀── kept current
              │  patched/dev (working branch)       │◀── your work
              └─────────────────────────────────────┘
```

**Key rules:**
- **`dev`** — Mirrors upstream/dev. Kept current via periodic sync.
- **`patched/dev`** — Your working branch. Contains patches + synced with upstream.
- **`origin`** — Your fork (push target). NOT the original repo.
- **`upstream`** — Original repo (read-only, never push).

---

## Syncing with Upstream (Staying Current)

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

---

## Making Changes to the Fork

### Scenario 1: Adding a new patch/feature

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

### Scenario 2: Fixing a merge conflict after rebase

```bash
# After git rebase upstream/dev fails:
git status  # shows conflicted files

# Resolve conflicts in each file, then:
git add <resolved-file>
git rebase --continue  # repeat until rebase completes
```

### Scenario 3: Temporarily switching to Homebrew opencode

```bash
# Remove OpenChamber config (switch back to Homebrew)
./build-and-install.sh --unconfigure-openchamber

# When ready to switch back:
./build-and-install.sh --configure-openchamber
```

---

## Building and Testing

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

---

## Pushing Changes to GitHub

**After making local changes:**
```bash
cd ~/www/misc/better-opencode
git push origin patched/dev
```

**If you need to force push (after rebase):**
```bash
git push origin patched/dev --force-with-lease
```

---

## Recovery Scenarios

| Problem | Solution |
|---------|----------|
| Rebase fails with conflicts | `git rebase --abort` to reset, then resolve manually |
| Accidentally modified `patched/dev` | `git checkout patched/dev && git reset --hard upstream/dev` |
| Lost local changes | Check `git reflog` to recover |
| Fork is far behind upstream | Run sync steps above, resolve conflicts iteratively |

---

## Common Mistakes to Avoid

- **Don't push to `upstream`** — `upstream` is read-only. Always push to `origin`.
- **Don't add patches to `dev`** — `dev` mirrors upstream/dev. Use `patched/dev` for your work.
- **Don't use `-X theirs` with local patches** — It will discard your changes on conflict.
- **Don't forget to fetch `origin/patched/dev`** — Your fork's remote may have updates you haven't seen.

---

## OpenChamber Integration

### Production: Using Built Binary

After building better-opencode, configure the VSCode extension to use the installed binary:

```bash
# 1. Build and install
cd /Users/oleksii.honchar/www/misc/better-opencode
./scripts/build-and-install.sh --install --clean

# 2. Configure openchamber VSCode extension settings:
#    - Open VSCode settings.json
#    - Add: "openchamber.opencodeBinary": "/Users/oleksii.honchar/bin/better-opencode"
#    - Or set in ~/.config/openchamber/settings.json
```

### Development: Using Dev Server

For development, connect the openchamber VSCode extension to the better-opencode dev server:

> **⚠️ Important:** Close VSCode/VSCodeVodium before running this script. Running both instances may cause conflicts.

**Using the convenience script (recommended):**

```bash
# Start dev server + VSCodeVodium (default)
./scripts/start-dev.sh

# Start dev server + VSCode
./scripts/start-dev.sh --vscode

# Force launch even if IDE is detected as running
./scripts/start-dev.sh --force

# Stop the dev server
./scripts/start-dev.sh --stop
```

**Manual setup:**

```bash
# Terminal 1: Start better-opencode dev server
cd /Users/oleksii.honchar/www/misc/better-opencode
OPENCODE_PORT=4096 OPENCODE_SERVER_PASSWORD=opencode_dev bun run --cwd packages/opencode --conditions=browser src/index.ts

# Terminal 2: Start VSCode with openchamber extension using external server
export OPENCODE_PORT=4096
export OPENCODE_SKIP_START=true
export OPENCODE_SERVER_PASSWORD=opencode_dev
code .  # or codium . for VSCodeVodium
```

**Key environment variables:**

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENCODE_PORT` | Port for dev server | `4096` |
| `OPENCODE_SKIP_START` | Skip spawning opencode | `true` |
| `OPENCODE_SERVER_PASSWORD` | Auth password | `opencode_dev` |

---

## Verification Commands

```bash
# Verify remotes are correct
git remote -v
# origin → oleksii-honchar/better-opencode.git (your fork)
# upstream → anomalyco/opencode.git (original)

# Verify current branch
git branch --show-current
# Should show: patched/dev

# Verify divergence
git log --oneline origin/patched/dev..patched/dev | wc -l  # commits ahead
git log --oneline patched/dev..origin/patched/dev | wc -l  # commits behind

# Verify openchamber binary configuration
cat ~/.config/openchamber/settings.json | grep opencodeBinary

# Verify better-opencode binary
~/bin/better-opencode --version
```

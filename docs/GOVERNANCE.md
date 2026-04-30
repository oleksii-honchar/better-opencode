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

### How openchamber Consumes better-opencode

OpenChamber has two consumption paths:

**1. SDK Packages (npm registry)**
- `@opencode-ai/sdk` — API client for opencode server
- Consumed via npm registry (published packages)
- Path: `packages/sdk/js/` in better-opencode
- Current version in openchamber: `^1.4.25`

**2. CLI Binary (local path)**
- The opencode CLI binary used by openchamber desktop/web
- Configured in openchamber's `settings.json`:
  ```json
  {
    "opencodeBinary": "/Users/oleksii.honchar/bin/better-opencode"
  }
  ```
- Binary built by `build-and-install.sh --install`
- Installed to: `~/bin/better-opencode`

### Dev Setup: Using Local better-opencode in openchamber

For development, you may want openchamber to use local better-opencode packages instead of published npm packages.

**Option A: file: Path Reference (Recommended for Dev)**

Edit `/Users/oleksii.honchar/www/misc/openchamber/package.json`:

```json
{
  "dependencies": {
    "@opencode-ai/sdk": "file:../better-opencode/packages/sdk/js"
  }
}
```

Then install and dev:
```bash
cd /Users/oleksii.honchar/www/misc/openchamber
bun install
bun run dev:web
```

**Option B: bun link**

```bash
# In better-opencode
cd /Users/oleksii.honchar/www/misc/better-opencode/packages/sdk/js
bun link

# In openchamber
cd /Users/oleksii.honchar/www/misc/openchamber
bun unlink @opencode-ai/sdk 2>/dev/null || true
bun link @opencode-ai/sdk
```

**Verify the link:**
```bash
cd /Users/oleksii.honchar/www/misc/openchamber
bun pm list @opencode-ai/sdk
```

### OpenChamber Configuration

The complete openchamber configuration for using better-opencode:

```bash
# 1. Build and install better-opencode binary
cd /Users/oleksii.honchar/www/misc/better-opencode
./build-and-install.sh --install --clean

# 2. Configure openchamber settings (already done in ~/.config/openchamber/settings.json)
# "opencodeBinary": "/Users/oleksii.honchar/bin/better-opencode"

# 3. (Optional) Set CLI env var for desktop scripts
echo 'export OPENCHAMBER_OPENCODE_PATH="/Users/oleksii.honchar/bin/better-opencode"' >> ~/.zshrc
source ~/.zshrc

# 4. Start openchamber dev
cd /Users/oleksii.honchar/www/misc/openchamber
bun run dev:web
```

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

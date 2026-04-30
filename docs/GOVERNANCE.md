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

### Development: OpenChamber + local OpenCode (two tabs)

Use `scripts/start-dev.sh`: **one terminal runs the OpenCode dev server (Bun)**, a **second terminal launches the IDE**. OpenChamber in the editor must be pointed at that server with **`openchamber.apiUrl`**; otherwise the extension starts its **own** `opencode serve` on a random port.

> **Before `--ide-only`:** Close VSCodium/VS Code (or pass `--force`). Two IDE instances can fight over ports and extension state.

#### Tab A — dev server (foreground)

From the repo root:

```bash
cd ~/www/misc/better-opencode
./scripts/start-dev.sh              # same as --server-only
# optional: ./scripts/start-dev.sh --port 5000
```

This runs `bun run --cwd packages/opencode …` on **`127.0.0.1`** and **`OPENCODE_PORT`** (default **4096**). Leave this tab open; **Ctrl+C** stops the server.

- **Stop without the tab:** `./scripts/start-dev.sh --stop` (kills the listener on `OPENCODE_PORT`).
- **Dev TLS (e.g. HTTPS to LiteLLM behind Caddy):** Bun does **not** use the macOS Keychain for CA trust. Either `export NODE_EXTRA_CA_CERTS=/path/to/chain.pem` before starting, or place the same PEM at **`~/.config/better-opencode/extra-ca.pem`** — the script sets `NODE_EXTRA_CA_CERTS` automatically when that file exists and the variable is unset.

The dev server is started **without** `OPENCODE_SERVER_PASSWORD` (no Basic auth on local HTTP).

#### Tab B — IDE only

After Tab A is healthy:

```bash
cd ~/www/misc/better-opencode
./scripts/start-dev.sh --ide-only           # VSCodium (default)
./scripts/start-dev.sh --ide-only --vscode  # VS Code
# Match Tab A if you changed the port:
./scripts/start-dev.sh --ide-only --port 5000
```

**Required once (User settings in VS Code / VSCodium):** set the OpenChamber API base URL to the dev server (same host/port as Tab A):

```json
"openchamber.apiUrl": "http://127.0.0.1:4096"
```

- **`OPENCODE_SKIP_START`** is used by the **OpenChamber web/desktop** server path; the **VS Code extension does not use it** to decide whether to spawn OpenCode. If `openchamber.apiUrl` is empty, the extension will spawn its own managed server.
- On **macOS**, if the `codium` CLI is missing, the script launches **`VSCodium.app/Contents/MacOS/VSCodium`** so `OPENCODE_PORT` reaches the GUI process (`open -a` does not pass your shell env).

#### Optional environment (see `./scripts/start-dev.sh --help`)

| Variable | Purpose |
|----------|---------|
| `BETTER_OPENCODE_DIR` | Repo path if not `~/www/misc/better-opencode` |
| `OPENCODE_PORT` | Dev server port (default `4096`) |
| `NODE_EXTRA_CA_CERTS` | PEM bundle for internal HTTPS (Caddy, custom roots); optional auto-load from `~/.config/better-opencode/extra-ca.pem` |
| `VSCODE_APP` | `codium` or `code` |
| `VSCODIUM_APP` / `VSCODIUM_APP_NAME` | macOS bundle path or `open -a` name overrides |

#### Quick troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Second `opencode serve` / random high port | `openchamber.apiUrl` not set (or wrong port) |
| `unable to get local issuer certificate` on chat / provider calls | Outbound HTTPS from Bun — add `NODE_EXTRA_CA_CERTS` or `extra-ca.pem` (Keychain alone is not enough) |
| IDE does not see `OPENCODE_PORT` on macOS | Use `codium` CLI or bundle binary launch; avoid relying on `open -a` alone for env |

---

### Development Mode: Using Dev Server with openchamber

For development, you can connect openchamber directly to the better-opencode dev server instead of using the installed binary.

**Using the convenience script (recommended):**

```bash
# Start dev server + VSCode (with VSCode)
cd /Users/oleksii.honchar/www/misc/better-opencode
./start-dev.sh

# Start dev server + VSCodeVodium
./start-dev.sh --vscodium

# Start with custom port and password
./start-dev.sh --port 5000 --password mysecret

# Stop the dev server
./start-dev.sh --stop
```

**Manual setup (without convenience script):**

```bash
# 1. Start better-opencode dev server
cd /Users/oleksii.honchar/www/misc/better-opencode
OPENCODE_PORT=4096 OPENCODE_SERVER_PASSWORD=opencode_dev bun run --cwd packages/opencode --conditions=browser src/index.ts

# 2. Start openchamber in external mode
cd /Users/oleksii.honchar/www/misc/openchamber
OPENCODE_PORT=4096 OPENCODE_SKIP_START=true OPENCODE_SERVER_PASSWORD=opencode_dev bun run openchamber:server

# 3. Or configure VSCode environment variables
export OPENCODE_PORT=4096
export OPENCODE_SKIP_START=true
export OPENCODE_SERVER_PASSWORD=opencode_dev
```

**Environment variables for dev mode:**

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENCODE_PORT` | Port for dev server | `4096` |
| `OPENCODE_SKIP_START` | Skip spawning opencode (use external) | `true` |
| `OPENCODE_SERVER_PASSWORD` | Auth password for dev server | `opencode_dev` |
| `VSCODE_APP` | VSCode variant: `code` or `codium` | `code` |
| `BETTER_OPENCODE_DIR` | Path to better-opencode | `~/www/misc/better-opencode` |

**VSCode extension configuration:**

The openchamber extension will automatically detect and use the external server when `OPENCODE_SKIP_START=true` is set. No additional configuration needed in VSCode settings.

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

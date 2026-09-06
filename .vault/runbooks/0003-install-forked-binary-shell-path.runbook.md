---
type: runbook
title: "Install Forked Binary and Make It Resolvable by the Shell"
createdAt: "2026-09-06T08:52:00Z"
updatedAt: "2026-09-06T08:52:00Z"
tags: [build, install, shell, path, zshrc, openchamber]
---

# Runbook: Install Forked Binary and Make It Resolvable by the Shell

## Prerequisites

- Fork repo at `/Volumes/Data/www/beaver/better-opencode` (or `BETTER_OPENCODE_DIR`)
- `bun` available
- zsh as the interactive shell

## Steps

### 1. Build and Install

```bash
cd /Volumes/Data/www/beaver/better-opencode
./build-and-install.sh --clean
```

Install is now the **default** (no `--install` flag needed). `--only-build` skips install. The
script builds the fork, copies the binary to `~/bin/better-opencode`, configures OpenChamber,
and runs `ensure_shell_integration` (idempotent `.zshrc` updates: uncomments the template
`~/bin` PATH line or appends `export PATH="$HOME/bin:$PATH"`, and sets
`OPENCHAMBER_OPENCODE_PATH` to the fork binary).

### 2. Verify the Binary Exists and Runs

```bash
~/bin/better-opencode --version
```

### 3. Add `~/bin` to PATH in `~/.zshrc`

The script now does this automatically via `ensure_shell_integration` (idempotent). For manual
reference, the fork docs (`docs/BETTER-OPENCODE.md`) require `~/bin` on PATH for bare-name use.
The default `.zshrc` template ships this line **commented out**:

```bash
# export PATH=$HOME/bin:/usr/local/bin:$PATH   # ← uncomment this
export PATH=$HOME/bin:/usr/local/bin:$PATH
```

Without this, `which better-opencode` → not found and `zsh: command not found`.

### 4. Point `OPENCHAMBER_OPENCODE_PATH` at the Fork Binary

The script now does this automatically. For manual reference: the installer used to only **print**
this recommendation; it never edited `.zshrc`. If the variable already exists with an old value,
it stays stale:

```bash
export OPENCHAMBER_OPENCODE_PATH="/Users/<user>/bin/better-opencode"
```

`~/.config/openchamber/settings.json` is updated automatically by the installer
(`"opencodeBinary": "/Users/<user>/bin/better-opencode"`) — no manual edit needed there.

### 5. Verify in a Fresh Shell

```bash
zsh -ic 'which better-opencode'          # → /Users/<user>/bin/better-opencode
zsh -ic 'better-opencode --version'      # → e.g. 0.0.0-patched/dev2-<ts>
zsh -ic 'echo $OPENCHAMBER_OPENCODE_PATH' # → /Users/<user>/bin/better-opencode
```

The `can't change option: zle` warnings from `zsh -ic` sourcing oh-my-zsh are benign.

## Verification

- `which better-opencode` in a fresh zsh resolves to `~/bin/better-opencode`
- `better-opencode --version` prints the fork version
- `OPENCHAMBER_OPENCODE_PATH` points at the fork binary
- The old `opencode` binary still resolves (`~/.opencode/bin/opencode`) — no regression

## Rollback

- Remove the uncommented `export PATH=$HOME/bin:...` line (re-comment it)
- Restore the previous `OPENCHAMBER_OPENCODE_PATH` value
- `~/.config/openchamber/settings.json`: remove `opencodeBinary` (or point back at the old binary)

## See Also

- `docs/BETTER-OPENCODE.md` — install/usage docs (PATH requirement, OpenChamber config)
- `build-and-install.sh` — installer (installs to `~/bin`, prints env-var recommendation only)
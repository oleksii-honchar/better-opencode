---
name: better-opencode-generalist
description: "Manage the better-opencode fork: sync with upstream, resolve rebase conflicts, build and install, create feature branches, merge fork changes. Use when user mentions better-opencode, update fork, sync with upstream, rebase patched/dev, merge feature branch, build better-opencode, start dev server, fork changes, upstream sync, cherry-pick fork."
version: "1.1"
updatedAt: "2026-07-18T10:00:00+0300"
author: "oleksii-honchar"
status: "draft"
tags: ["better-opencode", "fork-management", "git", "rebase", "upstream-sync"]
---

Better-OpenCode Generalist

## Role

Full-lifecycle specialist for the `better-opencode` fork: investigates sync issues, designs merge strategies, implements code changes, and verifies build/deploy readiness. Handles the complete workflow from upstream sync (rebase + conflict resolution) through feature development, build/install, and dev server setup.

**Position:** Can be invoked in any phase (investigation, architect, or implementer). Most valuable when the task spans fork operations (sync → rebase → build → install).

## Entry Point

**Read First:**
1. SESSION.md (if in a session) or PROBLEM_STATEMENT.md
2. `references/governance.md` — Fork structure, branch conventions, sync procedures, conflict resolution rules
3. `references/features.md` — Feature list and implementation status
4. `references/build-and-dev.md` — Build/install/dev server commands
5. `references/experience-log.md` — Session-tagged lessons learned (grows over time)

## Rules

### Cardio Rule — Targeted Testing Only

**Never run full test suites.** Every approach to running tests broadly is wrong for this repo:

| What NOT to do | Why it's wrong |
|---|---|
| `bun run test` (root) | Intentionally blocked — `exit 1` in root `package.json` |
| `bun turbo <pkg>#test` | Triggers `^build` dependency first — builds everything, takes minutes |
| `bun test` inside a package | Runs all tests in that package with no filter — too broad |
| `bun turbo test` or `bun turbo test:ci` | Same problem — slow build cascade, runs everything |

**Only acceptable approach — target specific test files directly:**

```bash
bun test packages/opencode/src/path/to/file.test.ts
bun test packages/core/src/path/to/file.test.ts --timeout 30000
bun test packages/opencode/src --filter "some-pattern"
```

**Why:**
- No turbo build cascade — bun runs the file directly
- Seconds instead of minutes
- You know exactly which tests you're running
- Failed assertions point directly to the feature you changed

**When to run which:**
- **After editing a file + its test:** `bun test packages/opencode/src/that-file.test.ts`
- **After editing a feature layer:** `bun test packages/opencode/src/feature-dir/`
- **After a typecheck-only change (no logic change):** skip tests — `bun turbo typecheck` is enough
- **Before pushing (sanity check):** targeted tests only — CI runs the full suite

### Code Search Decision Guide

Use this to pick the cheapest proof path. Every GitHub search needs a repo context.

| Question | Tool chain |
|---|---|
| Where is X defined in upstream/opencode? | `octocode_githubSearchCode` with `repo:opencode/opencode` → `octocode_githubGetFileContent` |
| Which PR added/changed X in upstream? | `octocode_githubSearchPullRequests` with `repo:opencode/opencode` |
| What does X look like in the fork after rebase? | `octocode_githubSearchCode` with `repo:your/fork` → verify against upstream |
| Explore upstream repo structure | `octocode_githubViewRepoStructure` |
| Quick local search in fork code? | `rg` — fast, local, no MCP overhead |

**Fallback:** If an Octocode tool is unavailable, use `gh` CLI equivalents (gh search, gh pr view). A warning inside a successful Octocode response is not a failure.

See 10-tools.mdc for full Octocode tool catalog.

1. **Index rule** — Use the always-on rule index at `~/.rules/olho/always-apply/`. It defines priority of truth and the repository map.
2. **Repository** — For detailed rules, read from **`~/.rules/olho/repository/`**. Use the index's "Repository Map" when needed.
3. **Fork docs** — The canonical source for fork procedures is `docs/GOVERNANCE.md` in the repo (`~/www/misc/better-opencode`). Read it before any rebase or merge operation.

## Workflow

### Phase 1: Upstream Sync (staying current)

**Goal:** Keep `patched/dev` on top of latest upstream/dev without losing fork features.

1. **Fetch and assess divergence:**
   ```bash
   cd ~/www/misc/better-opencode
   git fetch upstream dev --quiet
   git fetch origin --quiet
   git log --oneline patched/dev..upstream/dev | wc -l  # commits behind
   git log --oneline upstream/dev..patched/dev | wc -l  # commits ahead
   ```

2. **Rebase `patched/dev` onto `upstream/dev`:**
   ```bash
   git checkout patched/dev
   git rebase upstream/dev
   ```

3. **Resolve conflicts (if any):**
   - Apply the decision tree from `references/governance.md`: preserve our features, adapt to upstream patterns
   - For each conflict: edit file → `git add <file>` → `git rebase --continue`
   - If too messy: `git rebase --abort`, then resolve manually

4. **Push rebased branch:**
   ```bash
   git push origin patched/dev --force-with-lease
   ```

5. **Mandatory typecheck:**
   ```bash
   bun turbo typecheck
   ```

### Phase 2: Feature Branch Workflow (creating, rebasing, merging)

**Goal:** Develop a fork feature on a dedicated branch and merge it cleanly.

1. **Create feature branch from `patched/dev`:**
   ```bash
   git checkout patched/dev
   git pull origin patched/dev
   git checkout -b 260430-feat-01
   ```

2. **Develop and commit:**
   ```bash
   # Make changes...
   git add .
   git commit -m "feat: describe your change"
   git push origin 260430-feat-01
   ```

3. **Rebase onto `patched/dev` before merge:**
   ```bash
   git checkout patched/dev && git pull origin patched/dev
   git checkout 260430-feat-01
   git rebase patched/dev
   # Resolve conflicts (preserve our features)
   git push origin 260430-feat-01 --force-with-lease
   ```

4. **Merge into `patched/dev`:**
   ```bash
   git checkout patched/dev
   git merge 260430-feat-01 --no-ff
   git push origin patched/dev
   bun turbo typecheck
   ```

### Phase 3: Fork Change Transfers (cherry-picking fork features between branches)

**Goal:** Transfer fork features from one branch to another without cherry-pick conflicts.

When fork commits conflict heavily with upstream (common when rebasing old fork commits onto new upstream), **do NOT cherry-pick old fork commits**. Instead:

1. **Extract clean diffs from the already-adapted merge commit vs upstream base:**
   ```bash
   # Identify the merged commit that has fork features adapted to current patterns
   git log --oneline -20  # find the merge/adapt commit (e.g., 927eab170)

   # Get diff of adapted commit vs upstream base
   git diff upstream/dev..927eab170 > /tmp/fork-changes.patch
   ```

2. **Apply as separate per-feature patches on a new branch:**
   ```bash
   git checkout -b 260517-feat-cherrypick origin/patched/dev
   # Split the patch by feature and apply each as a separate commit
   # e.g., patch for MCP filtering, session ID, attachment resolution, etc.
   ```

3. **Verify and push:**
   ```bash
   bun turbo typecheck
   git push -u origin 260517-feat-cherrypick
   gh pr create --base patched/dev --head 260517-feat-cherrypick
   ```

### Phase 4: Build and Install

**Goal:** Build the forked binary and install it for use.

```bash
cd ~/www/misc/better-opencode

# Full build + install
./build-and-install.sh --install --clean

# Verify
~/bin/better-opencode --version
~/bin/better-opencode --help
```

### Phase 5: Dev Server Setup (OpenChamber integration)

**Goal:** Start the dev server and IDE for development work.

```bash
cd ~/www/misc/better-opencode

# Tab A — dev server
./scripts/start-dev.sh              # starts on port 4096

# Tab B — IDE (after Tab A is healthy)
./scripts/start-dev.sh --ide-only   # VSCodium default
./scripts/start-dev.sh --ide-only --vscode  # VS Code

# Stop server
./scripts/start-dev.sh --stop
```

**Required VSCode setting (once):**
```json
"openchamber.apiUrl": "http://127.0.0.1:4096"
```

### Phase 6: Targeted Testing (post-change verification)

**Goal:** Verify your code change by running only the relevant tests — never the full suite.

Run this after any logic change (not needed after pure typecheck-only changes).

1. **Find the relevant test file(s):**
   ```bash
   # Tests are co-located next to their source files
   # If you edited src/foo/bar.ts, the test is src/foo/bar.test.ts
   ls packages/opencode/src/path/to/feature/*.test.ts
   ```

2. **Run targeted test(s):**
   ```bash
   # Single file
   bun test packages/opencode/src/path/to/feature/bar.test.ts

   # All tests in a feature directory
   bun test packages/opencode/src/path/to/feature/

   # Pattern match across a package
   bun test packages/opencode/src --filter "feature-name"
   ```

3. **If tests fail:**
   - Fix the code, re-run the same targeted test
   - `bun test --rerun-every 2000` — watch mode with 2s debounce

**Turbo typecheck is separate and fast** — always run `bun turbo typecheck` after rebase/merge (see Phase 1-3). It does NOT trigger builds.

## Gotchas

- **Never push to upstream** — `upstream` is read-only. Always push to `origin` (oleksii-honchar/better-opencode).
- **`dev` mirrors upstream exactly** — Don't add patches to `dev`. Use `patched/dev` for your work.
- **Force-with-lease after rebase is required but dangerous** — Always confirm with the user before force-pushing. Verify the rebase succeeded first.
- **Fork features must be preserved during sync** — This is the #1 risk. Never use `-X theirs` or blindly accept upstream's version when our feature code is involved.
- **When fork commits conflict heavily with upstream** — Don't cherry-pick old fork commits. Extract diffs from an already-adapted merge commit vs upstream base, then apply as separate patches.
- **Typecheck after every merge/rebase** — `bun turbo typecheck` is mandatory. Upstream changes may break our feature code silently.
- **Never run full test suites** — `bun run test` (root) is blocked; `bun turbo <pkg>#test` triggers `^build` first (minutes). Use `bun test path/to/file.test.ts` instead — seconds, no build cascade.
- **Bun CA trust** — Bun does NOT use macOS Keychain for TLS. For dev server with Caddy TLS, set `NODE_EXTRA_CA_CERTS` or place cert at `~/.config/better-opencode/extra-ca.pem`.
- **Two IDE instances fight over ports** — Close VSCodium/VS Code before starting `start-dev.sh --ide-only`, or use `--force`.
- **`openchamber.apiUrl` must be set** — Without it, the VSCode extension spawns its own `opencode serve` on a random port instead of connecting to your dev server.

## Validation / Success Criteria

- [ ] Upstream sync: `patched/dev` is on top of `upstream/dev` (0 commits behind)
- [ ] Fork features preserved: no feature code lost during conflict resolution
- [ ] Typecheck passes: `bun turbo typecheck` succeeds with 0 errors
- [ ] Targeted tests pass (if logic changed): `bun test packages/<pkg>/src/path/to/changed-file.test.ts`
- [ ] Build succeeds: `./build-and-install.sh --install --clean` completes
- [ ] Binary works: `~/bin/better-opencode --version` returns expected version
- [ ] Force-push confirmed with user (if applicable)
- [ ] Experience log updated (if new pattern or gotcha discovered)

## When to Ask for Direction

- **Force-push confirmation** — Before any `--force-with-lease`, confirm with the user.
- **Conflict resolution ambiguity** — If a conflict involves both our code and upstream code in an unclear way, ask rather than guessing.
- **Feature branch scope** — If the user asks for a new feature, clarify which feature spec applies (see `references/features.md`).
- **Upstream PR status** — If a fork feature depends on an unmerged upstream PR (e.g., `session.stopping` hook from PR #16598), confirm whether to proceed with the patch or wait.
- **Dev environment setup** — If the user is on a new machine, ask about LiteLLM hostname and CA cert availability before starting dev server.

## Quality Checklist

- [ ] Fork structure respected: `dev` mirrors upstream, patches live on `patched/dev`
- [ ] No pushes to `upstream` (read-only)
- [ ] Upstream sync completed before making changes (if syncing was part of the task)
- [ ] Conflict resolution preserves fork features (no `-X theirs` on feature code)
- [ ] Typecheck passes after any rebase/merge
- [ ] Targeted tests pass after any logic change (not just typecheck-only)
- [ ] Build succeeds after any code change
- [ ] Feature branch rebased onto `patched/dev` before merge (if applicable)
- [ ] Experience log updated with lessons learned (if new pattern discovered)
- [ ] User confirmed before force-push (if applicable)

## Shared Patterns / References

- **`references/governance.md`** — Fork structure, branch conventions, sync procedures, conflict resolution rules, rebase workflow. Read before any rebase or merge.
- **`references/features.md`** — Feature list and implementation status. Read when developing or debugging fork features.
- **`references/build-and-dev.md`** — Build/install commands, dev server setup, OpenChamber integration, LiteLLM TLS/CA trust. Read when building or starting dev environment.
- **`references/experience-log.md`** — Session-tagged lessons learned from fork management. Read for historical context; update after discovering new patterns.

### Repository Rule References (from `~/.rules/olho/repository/`)

| When to read | File | Purpose |
|---|---|---|
| Before implementing tests for fork features | `05-testing.mdc` | Test patterns, verification approaches |
| For general codebase conventions | `01-principles.mdc`, `03-naming.mdc`, `04-patterns.mdc` | DDD boundaries, Result pattern, kebab-case naming |

</content>, 
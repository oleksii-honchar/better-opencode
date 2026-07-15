# Fork Governance — Quick Reference

Extracted from `~/www/misc/better-opencode/docs/GOVERNANCE.md`.

## Fork Structure

```
                      upstream/anomalyco/opencode
                      ┌─────────────────────────┐
                      │  dev (development)      │◀── upstream target, changes over time
                      └─────────────────────────┘
                                │
                                │ fork
                                ▼
                oleksii-honchar/better-opencode (origin)
                ┌─────────────────────────────────────┐
                │  dev (mirrors upstream/dev)         │◀── kept current, NEVER add patches here
                │  patched/dev (working branch)       │◀── patches + synced with upstream
                │  260430-feat-01, 260502-feat-05...  │◀── feature branches off patched/dev
                └─────────────────────────────────────┘
```

**Key rules:**
- **`dev`** — Mirrors upstream/dev. Kept current via periodic sync.
- **`patched/dev`** — Working branch. Contains patches + synced with upstream.
- **Feature branches** — Branch off `patched/dev`. Rebased onto `patched/dev` before merge.
- **`origin`** — Your fork (push target). NOT the original repo.
- **`upstream`** — Original repo (read-only, never push).

## Core Principle: Preserve Our Features

When resolving any merge or rebase conflict:
1. **Always preserve our feature code** — if a conflict exists between our changes and upstream changes, our feature logic wins.
2. **Adapt to upstream structural changes** — if upstream changed APIs, types, or patterns (e.g., Effect migration), adapt our feature code to the new upstream patterns while preserving its behavior.
3. **Never discard our feature changes** — do NOT use `-X theirs` or blindly accept upstream's version when our feature code is involved.
4. **If unsure, keep both** — include both our code and upstream's code, then clean up manually.

## Conflict Resolution Decision Tree

When a conflict marker appears:
1. **Is our code in the conflict?** → Keep our code, adapt to upstream patterns if needed.
2. **Is this a structural change (API, type, pattern)?** → Adapt our code to the new upstream pattern while preserving its behavior.
3. **Is this a doc/spec file for our feature?** → Keep our version.
4. **Is this a shared file where both sides added different things?** → Keep both, merge carefully.
5. **When in doubt** → Keep our code. It's safer to have a conflict to fix later than to lose feature code.

## Sync Procedure

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

# 4. Resolve conflicts (preserve our features!)
#    git add <resolved-file> → git rebase --continue
#    or git rebase --abort to cancel

# 5. Push rebased branch to your fork
git push origin patched/dev --force-with-lease

# 6. MANDATORY: typecheck
bun turbo typecheck
```

## Feature Branch Workflow

```bash
# Create feature branch
git checkout patched/dev && git pull origin patched/dev
git checkout -b 260430-feat-01
# ... make changes, commit ...
git push origin 260430-feat-01

# Rebase onto patched/dev before merge
git checkout patched/dev && git pull origin patched/dev
git checkout 260430-feat-01
git rebase patched/dev
# ... resolve conflicts ...
git push origin 260430-feat-01 --force-with-lease

# Merge into patched/dev
git checkout patched/dev
git merge 260430-feat-01 --no-ff
git push origin patched/dev
bun turbo typecheck
```

## Fork Change Transfer (when cherry-pick conflicts)

When fork commits conflict heavily with upstream, **do NOT cherry-pick old fork commits**:

1. Extract clean diffs from the already-adapted merge commit vs upstream base
2. Apply as separate per-feature patches on a new branch
3. Each feature = one commit with descriptive message
4. Typecheck and push

See `references/experience-log.md` for session-tagged examples.

## Common Mistakes to Avoid

- **Don't push to `upstream`** — Always push to `origin`
- **Don't add patches to `dev`** — Use `patched/dev`
- **Don't use `-X theirs` with local patches** — It discards your changes
- **Don't forget to fetch `origin/patched/dev`** — Your fork's remote may have updates
- **Don't merge feature branches without rebasing first** — Always rebase onto `patched/dev` before merging
- **Don't skip typecheck after rebase** — Upstream changes may break our feature code silently

</content>, 
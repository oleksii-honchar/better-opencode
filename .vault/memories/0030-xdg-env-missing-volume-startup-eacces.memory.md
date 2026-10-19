---
type: memory
title: "Startup EACCES mkdir '/Volumes/Data' — XDG_* Env Pointing at a Missing Volume Crashes global.ts Import"
createdAt: "2026-10-18T15:28:00Z"
updatedAt: "2026-10-18T15:28:00Z"
tags: [startup, xdg, global.ts, eacces, cross-machine, gotcha]
see_also:
  - "../runbooks/0003-install-forked-binary-shell-path.runbook.md"
---

# Memory: Startup EACCES mkdir '/Volumes/Data' — XDG_* Env Pointing at a Missing Volume Crashes global.ts Import

## Fact

`packages/core/src/global.ts` computes app dirs from `xdg-basedir` (honoring
`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, and `TMPDIR` for
tmp) and unconditionally runs `fs.mkdir(dir, { recursive: true })` for all of them **at
module import**. If any XDG variable points under a volume that does not exist on the
machine (e.g. `/Volumes/Data`, which exists only on the M6 workstation), recursive mkdir
fails creating the first missing ancestor — on macOS `/Volumes` is `root:wheel 0755`, so a
normal user gets:

```
EACCES: permission denied, mkdir '/Volumes/Data'
```

The error names only the failing ancestor, not the configured path nor the env var — it
looks like the app hardcodes `/Volumes/Data`; it does not.

## Context

Observed 2026-10-18 starting `scripts/start-dev.sh --server-only` on the old M1 mini
(headless node mmm1) with the repo at `~/better-opencode`. Reproduced byte-identically on
mmm1 with `XDG_DATA_HOME=/Volumes/Data/TMP/xdg-data bun run --cwd packages/opencode
--conditions=browser src/index.ts`; without the variable the same command starts cleanly.
mmm1's dotfiles carried no XDG exports (the variable came from the interactive session);
they do carry the analogous M6-only `HF_HOME=/Volumes/Data/...` export.

## Impact

Any node with synced dotfiles/session env can hit this wall at every entry point (server,
TUI, serve) before any logging exists. Proposed universal fix (session
261018-1720-fix-eacces-volumes-data, `materials/proposal-universal-fix.md`): wrap the
startup mkdirs in a `mkdirSafe()` that rethrows naming the offending env var, configured
path, and failing component — no silent fallback. Machine-side: `unset XDG_*` / correct the
export; keep node configs independent of the workstation's disk layout.

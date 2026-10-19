---
type: memory
title: "Bun 1.4.3 + OPENCODE_LOG_TOOLS=1 Hangs Server Startup (1.3.14 OK) — Pin Bun Across Nodes"
createdAt: "2026-10-18T15:45:00Z"
updatedAt: "2026-10-18T15:45:00Z"
tags: [bun, regression, tools-log, startup, cross-machine, gotcha]
see_also:
  - "./0030-xdg-env-missing-volume-startup-eacces.memory.md"
---

# Memory: Bun 1.4.3 + OPENCODE_LOG_TOOLS=1 Hangs Server Startup (1.3.14 OK)

## Fact

Under **Bun 1.4.3 (macOS arm64)**, starting the server with `OPENCODE_LOG_TOOLS=1`
(the tools-log subsystem, `packages/core/src/util/log.ts`) hangs silently after plugin
load: process alive, 0% CPU, idle event loop, port never bound, no error. Identical
startup under **Bun 1.3.14** is healthy. Rotation config (`TOOL_LOG_FILE_MAX_LINES=0`)
does not change it; a direct `Log.init()` probe settles — the wedge is in the full
server path (bun-internal, bug-report candidate).

## Context

Observed 2026-10-18 on the old M1 mini (mmm1) running `scripts/start-dev.sh` (which
always sets `OPENCODE_LOG_TOOLS=1`). mmm1's bun was 1.4.3 via npm-under-nvm because
`~/.bun/bin` was empty and PATH fell through; the M6 workstation runs 1.3.14 via
`~/.bun/bin/bun`. Isolated by env-var bisection (G1–G6 matrix, see session
261018-1720-fix-eacces-volumes-data findings).

## Impact

Symptom has no error text — looks like a config/plugin/telemetry problem (OTel
connections and XDG were red herrings). Rule: **pin the bun version across nodes**
(1.3.14 everywhere until 1.4.x is validated against this fork). Fix applied: installed
1.3.14 at `~/.bun/bin/bun` on mmm1, removed the npm bun from nvm; server healthy on
:4096. Diagnostic shortcut: if startup hangs with no error, first compare
`bun --version` across a working and a broken machine.

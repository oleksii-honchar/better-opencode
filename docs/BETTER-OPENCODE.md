# better-opencode

## Purpose

A maintained fork of [opencode](https://github.com/anomalyco/opencode) that patches critical gaps in the AI coding agent:

1. **Context loss after ~5 turns** — The agent forgets behavioral rules and workflow state after automatic compaction.
2. **Repetitive loops** — The agent gets stuck repeating the same actions without making progress. Addressed by the **Unstuck plugin** which detects and breaks loops automatically.
3. **Session opacity** — The agent has no awareness of its own session ID, making debugging and multi-session coordination difficult.

This fork provides plugin hooks for behavioral enforcement and session awareness that survive compaction.

---

## Features

The fork adds several features to address context loss, repetitive loops, session opacity, and context pollution:

- **`tool.execute.after` Inject (PR #19519)** — Plugins inject synthetic user messages after tool execution
- **`session.stopping` Hook (PR #16598)** — Plugins intercept idle/stop state and inject follow-up messages
- **Session ID in System Prompt** — `sessionID` and `parentSessionID` included in `<env>` block on every LLM call
- **Unstuck Plugin** — Detects and breaks model loops (thinking→tool-call, sentence-level, tool-only) with nudge-and-prune recovery
- **`supportedUrls` fallback** — Fixes `Object.entries(undefined)` crash when attaching images with models that don't define `supportedUrls` (defaults to `{}` via `overrideSupportedUrls` in `wrapLanguageModel`)

See **[FEATURES.md](./FEATURES.md)** for detailed descriptions and configuration.

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

---

## Runbook: Making Changes and Syncing with Source

For detailed governance procedures — fork structure, syncing with upstream, making changes, building, and pushing — see **[GOVERNANCE.md](./GOVERNANCE.md)**.

The governance document covers:
- Fork structure and branch conventions
- Upstream sync procedures (with conflict resolution)
- Feature branch workflow for adding patches
- Build and verification commands
- Push procedures and force-push safety
- Recovery scenarios and common mistakes to avoid

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

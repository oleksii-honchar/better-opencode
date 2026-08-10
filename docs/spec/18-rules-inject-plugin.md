# 18-rules-inject-plugin

## Context

Agents require access to always-apply rules — coding standards, repository conventions, tooling preferences, architectural decisions — on every session. Previously, this was handled by an external plugin file (`~/.config/opencode/plugins/rules-inject.ts`) with a hardcoded path (`~/.rules/always-apply`), no configuration, and no way to disable or customize behavior.

The Rules Injection Plugin moves this functionality into the opencode monorepo as a built-in, configurable plugin using the same pattern as the Unstuck plugin: a `rulesInject` config section with `enabled` and `alwaysApplyFolder` fields, registered in `INTERNAL_PLUGINS`, and wired via the `experimental.chat.system.transform` hook.

## Problem

Users need a way to inject always-apply rules into the system prompt without maintaining an external plugin file. The legacy external plugin had no configuration — the rules folder path was hardcoded, there was no way to disable it, and it ran for every context including non-session paths like title generation.

## Solution: Rules Inject Plugin

The plugin loads `.mdc` files from a configurable folder and injects them into the system prompt on the first turn of each session. It uses the `experimental.chat.system.transform` hook, which fires for both regular chat requests and agent sub-calls, ensuring rules are injected in all session contexts.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Plugin: RulesInject                       │
│                                                             │
│  config hook ──→ activeConfig = mergeConfig(cfg.rulesInject)│
│                                                             │
│  experimental.chat.system.transform hook:                   │
│    1. Skip if !activeConfig.enabled                         │
│    2. Skip if !input.sessionID (title/agent-gen paths)      │
│    3. Skip if injected.has(sessionID) (per-session dedupe)  │
│    4. rules = loadRules(activeConfig.alwaysApplyFolder)     │
│    5. If rules empty → return                              │
│    6. If system.length === 0 → return                      │
│    7. system[0] = rules + "\n\n" + system[0]               │
│    8. injected.add(sessionID)                              │
│                                                             │
│  loadRules(folder):                                         │
│    - Expand ~ to os.homedir()                               │
│    - readdir, filter *.mdc, sort by filename               │
│    - Each file → "Instructions from: <path>\n<content>"     │
│    - Join with "\n\n"                                       │
│    - On read error → log.warn, return ""                   │
└─────────────────────────────────────────────────────────────┘
```

### Config Key Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch. When `false`, the plugin skips injection entirely. Set to `false` to disable rule injection without removing the config. |
| `alwaysApplyFolder` | string | `"~/.rules/always-apply"` | Folder path to scan for `.mdc` rule files. The `~` is expanded to the user's home directory. Files are sorted alphabetically by filename. If the folder does not exist or is unreadable, the plugin logs a warning and no-ops (no rules injected, no error thrown — see ADR-003). |
| `position` | `"before" \| "after-persona"` | `"before"` | Where to inject rules relative to the agent persona block. `"before"` prepends rules to the start of the system prompt (default, backward compatible). `"after-persona"` inserts rules between the persona block and the env block — the plugin splits `system[0]` at the first occurrence of the env marker `"You are powered by the model named"` and places rules directly before it. If the marker is not found, it falls back to prepend with a debug log (see Behavior Notes). |

### Configuration via opencode config

Default configuration (no user override needed):

```json
{
  "rulesInject": {
    "enabled": true,
    "alwaysApplyFolder": "~/.rules/always-apply"
  }
}
```

Override for olho users (use the olho-specific rules folder):

```json
{
  "rulesInject": {
    "enabled": true,
    "alwaysApplyFolder": "~/.rules/olho/always-apply"
  }
}
```

Inject rules after the agent persona block (olho users):

```json
{
  "rulesInject": {
    "enabled": true,
    "alwaysApplyFolder": "~/.rules/olho/always-apply",
    "position": "after-persona"
  }
}
```

With `"position": "after-persona"`, rules land between the agent persona block and the env block (`"You are powered by the model named ..."`), instead of before the persona.

Disable entirely:

```json
{
  "rulesInject": {
    "enabled": false
  }
}
```

### Behavior Notes

**Single system element:** All loaded rules are concatenated and prepended to the first system prompt element (`system[0]`). This matches the Qwen3 chat template, which expects exactly one system message. The plugin does not create additional system elements.

**Placement (`position`):** With the default `"before"`, rules are prepended to `system[0]` as described above. With `"after-persona"`, the plugin finds the first occurrence of the env marker `"You are powered by the model named"` in `system[0]` and inserts `rules + "\n\n"` immediately BEFORE the marker — placing rules between the agent persona block and the env block. The env block is generated deterministically by the runtime (session/system.ts), so the marker is a stable persona boundary. If the marker is not found (unusual paths), the plugin logs a debug message and falls back to prepend, so rules are still injected. Placement is per-session like all injection; the `injected` dedupe set applies regardless of position.

**Per-session deduplication:** Rules are injected only once per `sessionID`. The plugin maintains an in-memory `Set<string>` of session IDs that have already received injection. After compaction, when the system prompt is rebuilt, the deduplication set prevents re-injection.

**Skip when no sessionID:** Non-session contexts (title generation, agent generation) do not receive injected rules. The plugin skips injection when `input.sessionID` is absent, avoiding rule injection into contexts where the rules are not relevant.

**Missing folder no-ops with warn log (ADR-003):** If the configured `alwaysApplyFolder` does not exist or is unreadable, the plugin logs a warning and returns without injecting rules. No error is thrown — the session continues normally without the rules. This is intentional: the default folder (`~/.rules/always-apply`) may not exist on all systems, and the plugin should not break sessions for users who haven't set up rules yet.

**File format:** Only `.mdc` files are loaded. Files are sorted alphabetically by filename. Each file's content is prefixed with `Instructions from: <absolute-path>` and files are joined with double newlines (`\n\n`).

**Config hook semantics:** The plugin reads the config once via the `config` hook and stores it in module state (`activeConfig`). Config changes take effect on the next process start — same snapshot semantics as auth plugins.

### Log Filtering

The plugin emits structured logs tagged with `service: "plugin.rules-inject"`. Use `grep` or `rg` to filter logs:

```bash
# Show all rules-inject logs
grep -i "service.*plugin.rules-inject" ~/.opencode/logs/* 2>/dev/null

# Show warnings (missing folder, unreadable files)
grep -i "service.*plugin.rules-inject" ~/.opencode/logs/* 2>/dev/null | \
  grep -i "warn"
```

### Migration from External Plugin

If you were using the legacy external plugin (`~/.config/opencode/plugins/rules-inject.ts`):

1. Remove `"./plugins/rules-inject.ts"` from the `plugin` array in `opencode.jsonc`.
2. Add the `rulesInject` config section to the root of `opencode.jsonc` (if you need a custom folder).
3. Delete `~/.config/opencode/plugins/rules-inject.ts`.

The built-in plugin provides the same functionality with configuration support.

### Key Design Decisions

- **Built-in over external plugin** — Eliminates the need for users to maintain external plugin files; configuration is declarative in `opencode.json`.
- **`experimental.chat.system.transform` hook** — Covers both regular chat and agent sub-calls automatically; no separate wiring needed.
- **Single system element** — Matches Qwen3 chat template requirements; avoids creating additional system messages.
- **Per-session dedupe** — Prevents re-injection after compaction; rules appear exactly once per session.
- **Skip non-session contexts** — Title generation and agent generation do not receive rules; they are not agent sessions.
- **Warn on missing folder (ADR-003)** — The default folder may not exist; the plugin should not break sessions for users without rules configured.

---

**Related**: Session `260801-1639-rules-inject-plugin-move` at `~/.agent-sessions/26/08/01/260801-1639-rules-inject-plugin-move/` contains the full research findings, spec, and decisions.

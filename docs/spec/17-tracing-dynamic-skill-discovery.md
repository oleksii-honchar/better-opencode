# Tracing Dynamic Skill Discovery

This document explains how to trace dynamic skill discovery operations in better-opencode.

When a user mentions or a tool reads a file from a different repo, better-opencode dynamically discovers and injects that repo's skills. All operations are logged with a unique tag for easy filtering.

## Quick Start

### Enable logging

Dynamic skill discovery logs are emitted by default. No special environment variable needed.

### Filter logs

```bash
# All dynamic skill discovery events
grep '"tag":"dynamic-skills"' ~/.opencode/log/opencode.log

# With context (last 100 lines, color)
tail -100 ~/.opencode/log/opencode.log | grep --color '"tag":"dynamic-skills"'

# JSON structured logs — filter by tag
jq -c 'select(.tag == "dynamic-skills")' ~/.opencode/log/opencode.log

./scripts/start-dev.sh --server-logs | rg "dynamic-skills"
```

## Event Reference

Every dynamic skill discovery log entry includes:

- `tag: "dynamic-skills"` — the filter key
- `event` — the operation name (see table below)
- Additional context fields (filePath, skillName, repoRoot, etc.)

| Event | Level | When it fires | Key fields |
|-------|-------|---------------|------------|
| `trigger-prompt` | debug | User message contains file paths | partType, pathCount |
| `trigger-tool` | debug | Tool executes with file arg | toolId, filePath |
| `walk-up` | debug | Scanner walks directories looking for `.agents/` | filePath, foundDirs |
| `cache-hit` | debug | Folder already scanned in this session | repoRoot, filePath |
| `cache-miss` | debug | First time scanning this folder | repoRoot, filePath |
| `scan-complete` | info | Scan found skills | repoRoot, count |
| `scan-empty` | debug | Scan found no skills | repoRoot |
| `registered` | info | Skill registered as dynamic | skillName, repoRoot |
| `skipped` | debug | Skill skipped (duplicate or startup priority) | skillName, reason |
| `synthetic-injected` | info | Synthetic message injected for immediate visibility | skillCount |
| `post-compaction-restore` | info | Skills promoted to system prompt after compaction | count |
| `error` | warn | Non-blocking scan error (never fails pipeline) | error, filePath, stage |

## Tracing a Complete Flow

### Scenario: User mentions a file from another repo

```
User message: "Check /Users/oleksii.honchar/www/olho/voqaria/src/billing.ts"
```

Expected log sequence:

```
1. {"tag":"dynamic-skills","event":"trigger-prompt","partType":"text","pathCount":1}
2. {"tag":"dynamic-skills","event":"cache-miss","repoRoot":"/Users/oleksii.honchar/www/olho/voqaria","filePath":".../billing.ts"}
3. {"tag":"dynamic-skills","event":"walk-up","filePath":".../billing.ts","foundDirs":[".../voqaria/.agents"]}
4. {"tag":"dynamic-skills","event":"scan-complete","repoRoot":".../voqaria","count":2}
5. {"tag":"dynamic-skills","event":"registered","skillName":"billing-engine-generalist","repoRoot":".../voqaria"}
6. {"tag":"dynamic-skills","event":"registered","skillName":"expenses-generalist","repoRoot":".../voqaria"}
7. {"tag":"dynamic-skills","event":"synthetic-injected","skillCount":2}
```

**Interpretation:**
- Step 1: User message scanned, 1 file path found
- Step 2: First time seeing voqaria repo — cache miss, will scan
- Step 3: Found `.agents/` directory via walk-up
- Step 4: Scan completed, 2 skills found
- Step 5-6: Both skills registered as dynamic (not in system prompt yet — KV cache preserved)
- Step 7: Skills injected as synthetic message for immediate visibility

### Scenario: Same repo file mentioned again

```
User message: "Also check /Users/oleksii.honchar/www/olho/voqaria/src/payroll.ts"
```

Expected log sequence:

```
1. {"tag":"dynamic-skills","event":"trigger-prompt","partType":"text","pathCount":1}
2. {"tag":"dynamic-skills","event":"cache-hit","repoRoot":"/Users/oleksii.honchar/www/olho/voqaria","filePath":".../payroll.ts"}
```

**Interpretation:**
- Step 1: User message scanned, 1 file path found
- Step 2: Cache hit — voqaria already scanned, no redundant scan

### Scenario: Post-compaction promotion

After compaction completes:

```
{"tag":"dynamic-skills","event":"post-compaction-restore","count":2}
```

**Interpretation:**
- Skills moved from dynamic storage to startup storage
- Now appear in system prompt via `available()`
- Discoverable via `skill_search` meta tool

## Tracing Tool-Triggered Discovery

### Scenario: Agent reads a file from another repo

```
Agent calls read(filePath="/Users/oleksii.honchar/www/olho/puma-lan/config/docker-compose.yml")
```

Expected log sequence:

```
1. {"tag":"dynamic-skills","event":"trigger-tool","toolId":"read","filePath":".../docker-compose.yml"}
2. {"tag":"dynamic-skills","event":"cache-miss","repoRoot":"/Users/oleksii.honchar/www/olho/puma-lan","filePath":".../docker-compose.yml"}
3. ... (same scan/registration flow as above)
```

**Interpretation:**
- Step 1: Tool execution triggered scan
- Step 2+: Same scan/registration flow as user message trigger

## Debugging Checklist

If dynamic skill discovery doesn't seem to be working:

1. **Check trigger fires:** `grep '"event":"trigger-prompt"'` — if missing, file path not detected in message
2. **Check scan runs:** `grep '"event":"cache-miss"'` — if present, scan is happening
3. **Check scan finds skills:** `grep '"event":"scan-complete"'` — if count=0, no SKILL.md files found
4. **Check registration:** `grep '"event":"registered"'` — if missing with reason="startup-priority", skill name collides with startup skill
5. **Check injection:** `grep '"event":"synthetic-injected"'` — if missing, injection failed
6. **Check errors:** `grep '"event":"error"'` — any scan errors (non-blocking, but informative)

## Architecture Note

Dynamic skills use a two-phase visibility model:

- **Phase 1 (pre-compaction):** Skills are visible via synthetic messages in conversation context. System prompt is unchanged → KV cache preserved.
- **Phase 2 (post-compaction):** Skills are promoted to system prompt. Now visible via `skill_search` and system prompt `<available_skills>` block.

This is why you see `synthetic-injected` before `post-compaction-restore` in the logs.

---

For more details on the feature architecture, see the vault:

- `.vault/adrs/0055-dynamic-skill-registration.adr.md`
- `.vault/adrs/0057-two-phase-context-injection.adr.md`
- `.vault/specifications/0011-dynamic-skill-discovery.spec.md`

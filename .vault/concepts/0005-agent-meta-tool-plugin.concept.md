---
type: concept
title: "Agent Meta Tool Plugin"
createdAt: "2026-06-14T13:10:00Z"
updatedAt: "2026-06-14T13:10:00Z"
tags: [agent-meta-tool, plugin, skills, tools, system-prompt]
see_also:
  - "adrs/0007-always-extract-skills.adr.md"
  - "adrs/0008-leave-tools-transform-unchanged.adr.md"
  - "specifications/0002-meta-skill-enabled-switch.spec.md"
  - "concepts/0002-system-prompt.concept.md"
---

# Concept: Agent Meta Tool Plugin

## What

`@olho/agent-meta-tool` is an opencode plugin that intercepts the system prompt and tool definitions to replace static skill/tool content with dynamic meta-tool-driven access. It registers two hooks:

| Hook | Handler | Purpose |
|------|---------|---------|
| `experimental.chat.system.transform` | `systemTransform` | Intercepts system prompt, replaces `<available_skills>` block |
| `experimental.tools.transform` | `toolsTransform` | Intercepts tool definitions, replaces MCP tools with meta tools |

## Why

OpenCode loads skills as static XML blocks in the system prompt. As the number of skills grows, the prompt becomes bloated (large system prompt = higher cost, slower inference). The meta-tool plugin solves this by:

1. **Removing skill content from the system prompt** — replacing it with a lightweight `<amt-system-reminder>` that tells the model to use meta tools instead
2. **Providing meta tools** — `skill_search`, `tool_search`, `tool_use` that agents use at runtime to discover and invoke skills/tools dynamically

## Key Details

### Skill Processing (`systemTransform`)

The system transform has two operations that are **separated** by design:

- **Always runs:** Parsing the `<available_skills>` XML block and extracting skill metadata into `metaState.skills`. This is required for `skill_search` to function.
- **Conditional (when enabled):** Replacing `<available_skills>` with `<amt-system-reminder>`. The `metaSkillEnabled` switch controls this.

### Tool Processing (`toolsTransform`)

Always runs unchanged — passes through built-in tools and the `skill` tool, adds 3 meta tools, and strips MCP/registry tools (accessible only via meta tools).

### Configuration

The `metaSkillEnabled` switch in `opencode.json` controls skill processing:
- `true` (default): current meta behavior — skills replaced in system prompt
- `false`: skills remain in system prompt as standard, meta tools still work

### Shared State (MetaState)

A singleton holds:
- `skills: SkillInfo[]` — extracted skill metadata (always populated)
- `tools: Record<string, any>` — original tool definitions
- `toolIndex: ToolInfo[]` — searchable MCP tool index

### Node Location

`/Users/oleksii.honchar/www/misc/agent-meta-tool` — separate NPM package consumed by better-opencode.

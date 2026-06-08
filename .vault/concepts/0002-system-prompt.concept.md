---
type: concept
title: "System Prompt Composition"
createdAt: "2026-06-08T18:50:00Z"
updatedAt: "2026-06-08T18:50:00Z"
tags: [prompt, runtime, instruction]
see_also: ["concepts/0001-session-model.concept.md"]
---

# Concept: System Prompt Composition

## What

The system prompt in better-opencode is not stored in a single file. It is assembled at runtime from multiple layers: provider-specific builtin prompts, agent-specific instructions, user-provided instruction files (AGENTS.md, CLAUDE.md), and loaded skills. The final composite prompt is injected as a system message before the conversation history.

## Why

This layered approach lets the system adapt behavior per-provider (different model families have different prompt styles), per-agent (explore vs compaction vs build), and per-project (user-level instruction files), without duplicating content.

## Composition Order

Assembled in `LLMRequestPrep.prepare()` (`session/llm/request.ts`):

```
Step 1: agent.prompt ?? provider_specific_prompt(model)
Step 2: ...user instruction files (AGENTS.md, CLAUDE.md, etc.)
Step 3: ...user.message.system (from session metadata)
Step 4: Plugin transform hook ("experimental.chat.system.transform")
```

Each layer can extend or override the previous one. The result is joined with newlines into a single system message.

## Source Layers

### Layer 1 — Provider-specific builtin prompts

Builtin `.txt` files in `packages/opencode/src/session/prompt/`:

| File | Models |
|------|--------|
| `default.txt` | Fallback for unknown models |
| `gpt.txt` | `gpt-*` |
| `beast.txt` | `gpt-4-*`, `o1`, `o3` |
| `anthropic.txt` | `claude-*` |
| `gemini.txt` | `gemini-*` |
| `codex.txt` | `gpt-*-codex-*` |
| `kimi.txt` | `kimi-*` |
| `trinity.txt` | `trinity-*` |

Selected by `SystemPrompt.provider(model)` in `system.ts` — matches the model's `api.id` string.

### Layer 2 — Agent-specific prompts

Each agent can define its own `prompt` field (in `agent/agent.ts`):

| Agent | Prompt file |
|-------|-------------|
| `explore` | `agent/prompt/explore.txt` |
| `scout` | `agent/prompt/scout.txt` |
| `compaction` | `agent/prompt/compaction.txt` |
| `title` | `agent/prompt/title.txt` |
| `summary` | `agent/prompt/summary.txt` |
| Custom (from `opencode.json`) | `agent.<name>.prompt` config value |

If `agent.prompt` is set, it **replaces** the provider-specific prompt. Otherwise, the provider-specific prompt is used.

### Layer 3 — User instruction files

Resolved by `Instruction.system()` in `instruction.ts`, loaded from disk at runtime:

| Source | Path | Priority |
|--------|------|----------|
| Global | `~/.config/opencode/AGENTS.md` or `~/.claude/CLAUDE.md` | First (global) |
| Project | `AGENTS.md`, `CLAUDE.md` (via `findUp` from cwd to worktree root) | Second (project) |
| Config | `opencode.json → instructions[]` (paths or URLs) | Third (explicit) |

The first project-level match wins per filename — you don't stack `AGENTS.md` from every ancestor directory.

### Layer 4 — Skills

`SystemPrompt.skills(agent)` reads from `.agents/skills/` and injects available skills as `<available_skills>` blocks. The skill tool description is also appended.

### Layer 5 — Environment block

`SystemPrompt.environment()` injects a `<env>` block with: working directory, workspace root, VS Code workspace folders, git status, platform, today's date, session ID, and parent session ID (for sub-agent sessions).

## Delivery Modes

The assembled system prompt reaches the LLM in one of three ways, depending on the provider:

| Provider | Delivery |
|----------|----------|
| Standard | Prepended as `role: "system"` messages before conversation history |
| OpenAI OAuth | Set as `options.instructions` (system messages not supported by OAuth flow) |
| GitLab workflow | Set as `workflowModel.systemPrompt` property |

## Plugin Hooks

| Hook | Purpose |
|------|---------|
| `experimental.chat.system.transform` | Transform the system prompt array before sending to LLM |
| `chat.params` | Modify temperature, topP, maxOutputTokens, etc. |
| `chat.headers` | Add custom HTTP headers to the LLM request |

## Relevant Code

- `packages/opencode/src/session/llm/request.ts` — `LLMRequestPrep.prepare()`: composition logic
- `packages/opencode/src/session/system.ts` — `SystemPrompt.provider()`: model-to-prompt mapping
- `packages/opencode/src/session/instruction.ts` — `Instruction.system()`: user instruction file resolution
- `packages/opencode/src/agent/agent.ts` — Agent definitions with `prompt` field
- `packages/opencode/src/session/prompt/*.txt` — Builtin provider-specific prompts
- `packages/opencode/src/agent/prompt/*.txt` — Agent-specific prompts

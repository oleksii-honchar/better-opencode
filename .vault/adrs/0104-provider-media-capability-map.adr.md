---
type: adr
id: ADR-0104
title: "Provider Capability Map for Tool-Result Media Input"
status: accepted
createdAt: "2026-09-03T12:50:00Z"
updatedAt: "2026-09-03T12:50:00Z"
tags: [media, providers, tool-result, llm]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0103-media-in-chat-ismedia-extension.adr.md"
  - "specifications/0021-agent-media-in-chat.spec.md"
---

# ADR-0104: Provider Capability Map for Tool-Result Media Input

## Context

`supportsMediaInToolResult()` hard-coded image-only support for Bedrock/xAI. OpenAI and Anthropic
accept media in tool-result content; Moonshot/openai-compatible accept video/audio via AI SDK
file parts; few providers accept native video/audio in chat today.

## Decision

Replace the hard-coded body with a per-provider capability map keyed by `model.api.npm` (the AI
SDK provider package). Supported media stays in tool-result content; unsupported media is
extracted to the synthetic user message (`SYNTHETIC_ATTACHMENT_PROMPT`). Never inject an
unsupported media type into tool-result content (SDK rejection risk).

- `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google-vertex/anthropic` — accept media in
  tool-result content.
- `@ai-sdk/amazon-bedrock`, `@ai-sdk/xai` — image-only.
- `@ai-sdk/google` — gemini-3 only (existing logic).
- `@ai-sdk/openai-compatible` — video/audio via file parts when supported.
- default — `false` (all media extracted to synthetic user message).

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Keep image-only gates | Minimal change | Silently drops video/audio from model input | Capability map delivers both display and provider input where supported |

## Consequences

- **Positive:** provider input honored where supported; no SDK rejection of unsupported media.
- **Negative:** more logic to maintain per provider; default false is conservative.
- **Neutral:** media always reaches the renderer as `FilePart` regardless of provider input path.

## Verification (codebase)

- `message-v2.ts` lines ~762-792 — `mediaInToolResultCapability` map keyed by `model.api.npm`;
  `supportsMediaInToolResult` reads the map. Lines ~934-938 — extraction only for unsupported.

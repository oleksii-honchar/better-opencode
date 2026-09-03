---
type: adr
id: ADR-0105
title: "Display-First Render Pipeline — Post Media to Chat, Provider Input Secondary"
status: accepted
createdAt: "2026-09-03T12:50:00Z"
updatedAt: "2026-09-03T12:50:00Z"
tags: [media, chat, display, renderer, provider]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0103-media-in-chat-ismedia-extension.adr.md"
  - "specifications/0021-agent-media-in-chat.spec.md"
---

# ADR-0105: Display-First Render Pipeline

## Context

User intent is "post images or videos in chat" — **display**. Most providers cannot take native
video/audio input today. The renderer must render what the agent emits regardless of provider
input capability; transport is display-first via `FilePart`.

## Decision

The part travels to the client for display; for providers that cannot take the media type,
synthetic-user extraction is capability-gated (ADR-0104). The renderer shows native
`<video>`/`<audio>` players with `preload="metadata"` poster/thumbnail; no transcode in v1.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Transcode / generate frames server-side (ffmpeg/wasm) | Player-friendly thumbnails | ffmpeg/wasm dependency, out of scope | "Post, not re-encode"; poster-frame generation is a documented follow-up |

## Consequences

- **Positive:** display works for all media regardless of provider input support.
- **Negative:** provider input for video/audio remains limited to capability-mapped providers.
- **Neutral:** v1 ships native players without server-side processing.

## Verification (codebase)

- Render-side player branches (`<video>`/`<audio>`) verified in openchamber gallery/
  FileAttachment (render repo); opencode side carries `FilePart` to the client.

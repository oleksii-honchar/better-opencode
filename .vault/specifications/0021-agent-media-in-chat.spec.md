---
type: specification
id: SPEC-0021
title: "Agent Media Posting in Chat"
status: approved
createdAt: "2026-09-03T12:50:00Z"
updatedAt: "2026-09-03T12:50:00Z"
tags: [media, chat, message-pipeline, provider, renderer, v1]
owner: ""
target: 2026-09-03
adr_refs:
  - ADR-0103
  - ADR-0104
  - ADR-0105
see_also:
  - "adrs/0103-media-in-chat-ismedia-extension.adr.md"
  - "adrs/0104-provider-media-capability-map.adr.md"
  - "adrs/0105-display-first-render-pipeline.adr.md"
---

# Specification: Agent Media Posting in Chat

## Goal

Enable agents to **post** media (images, videos, audio, gifs) into the chat end-to-end:
emitted by better-opencode (message/part pipeline, tool results) and rendered by
better-openchamber (web UI + VS Code extension). Both sides gate image/(PDF) MIME only today.

## Behaviors (key)

- `isMedia` treats `image/*`, `video/*`, `audio/*`, `application/pdf` as media.
- Tool-result media input follows the provider capability map (ADR-0104); unsupported media is
  extracted to the synthetic user message.
- Renderer validates media MIME + size caps (image 10 MiB, video 50 MiB, audio 20 MiB) +
  container signatures; failure states (missing/too-large/unsupported) surface without crash.
- VS Code resolves OpenCode temp-dir media via path-bound forwarded grants (ADR-0012).

## Risks

- **Provider rejects unsupported media in tool-result content** → capability map gates
  extraction; never inject unsupported media.
- **Security: temp-dir/media grants scope** → grants path-bound; realpath containment;
  `markdownImageSources` authority; VS Code local bridge stays workspace-only.
- **Video size (10s MB)** → shared caps at grant + renderer; failure states; no crash.
- **Fork divergence / behavior regression** → pattern-based changes on fork-origin files; tests
  preserve current behavior; no part-model rewrite.

## Milestones

- 2026-09-03: feature implemented on both forks; reviewer PASS; promoted to vault.

## Links

ADRs 0103/0104/0105 (this vault); render-side ADRs 0011/0012/0013 + concept 0004
(better-openchamber vault).

---
type: adr
id: ADR-0103
title: "Agent Media Posting in Chat — Extend isMedia/FilePart, No New Part Type"
status: accepted
createdAt: "2026-09-03T12:50:00Z"
updatedAt: "2026-09-03T12:50:00Z"
tags: [media, chat, message-pipeline, part-model, session]
supersedes: []
superseded_by: []
see_also:
  - "adrs/0104-provider-media-capability-map.adr.md"
  - "adrs/0105-display-first-render-pipeline.adr.md"
  - "specifications/0021-agent-media-in-chat.spec.md"
---

# ADR-0103: Agent Media Posting in Chat — Extend isMedia/FilePart, No New Part Type

## Context

The transport (`FilePart {type:"file", mime, url, filename}`, SDK file parts, server events,
openchamber store) already carries media. `isMedia()` in `util/media.ts` gated `image/*` +
`application/pdf` only, so video/audio never entered the message model (not extracted to
synthetic user messages, not stripped on compaction). The user asked to let agents **post**
images, videos, audio, and gifs into chat; GIF is `image/gif`, so only video/audio were the new
modalities.

## Decision

Extend `isMedia()` to cover `video/*` and `audio/*` (plus `application/pdf`). Introduce **no
new part type** — the existing `FilePart` shape suffices; optional additive fields
(`poster`, `duration`) may be added later on `FilePart`.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| New dedicated `MediaPart` | Explicit poster/duration fields | New transport + store + render surface | Existing shape suffices; fields additive on `FilePart` later |
| Keep image-only gates | Zero change | Video/audio silently dropped from model input | Feature requires video/audio |

## Consequences

- **Positive:** video/audio now flow through message-v2 media extraction, processor
  normalization awareness, compaction `stripMedia`, and render as `FilePart`.
- **Negative:** providers that can't take native video/audio need capability-gated extraction
  (see ADR-0104).
- **Neutral:** no schema/persistence migration; only new MIME values flow through.

## Verification (codebase)

- `packages/opencode/src/util/media.ts` — `isMedia(mime) = image/* || video/* || audio/* || isPdfAttachment`.
- `processor.ts` gate lets `video/*`/`audio/*` pass through un-normalized (no resize).
- `compaction.ts` stripMedia removes `part.type === "file" && isMedia(part.mime)`.

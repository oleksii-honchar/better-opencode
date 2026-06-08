---
type: concept
title: "Session Model"
createdAt: "2026-06-08T18:45:00Z"
updatedAt: "2026-06-08T18:45:00Z"
tags: [session, architecture, hierarchy]
see_also: ["architectures/better-opencode/components/0001-session-storage.component.md"]
---

# Concept: Session Model

## What

A session is the primary conversation container in better-opencode. Sessions form a parent-child tree: a root session (created by the user) can spawn child sessions for sub-agent tasks. Each session carries an `agent` identifier and a `model` configuration.

## Why

The session model enables hierarchical task delegation — a main agent can offload work to specialized sub-agents, each with their own isolated conversation context, while maintaining a traceable lineage back to the original user request.

## Key Details

- **SessionTable schema**: `id` (SessionID), `parent_id` (nullable SessionID), `title`, `agent`, `model` (JSON with providerID, modelID, variant), `metadata` (JSON), `time` (created, updated)
- **Parent-child relationship**: `parent_id` is NULL for root sessions; child sessions link to their parent via this field. A session can have multiple children.
- **Querying children**: `Session.children(parentID)` returns all direct children of a session.
- **Querying parent**: `Session.parent(sessionID)` returns the parent session (if any).
- **Session creation**: `Session.create({ parentID, title, agent, model, metadata, time })` — used by both user-initiated sessions and subtask spawning.
- **Subtask creation**: The `TaskTool` creates child sessions with `parentID` set to the caller's session ID, spawning a new agent in a separate execution context.

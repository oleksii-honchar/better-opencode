---
type: adr
title: "Agent-Persona-Coach — Add Loop Reflection to Existing Nudges"
id: 6
status: accepted
createdAt: "2026-06-21T00:00:00Z"
tags: [agent-persona-coach, loop-prevention, behavioral]
see_also:
  - "../specifications/0004-unstuck-loop-detection.spec.md"
---

# ADR-0021: Agent-Persona-Coach — Add Loop Reflection to Existing Nudges

**ADR ID:** ADR-6
**Status:** accepted
**Date:** 2026-06-21

## Context

Agent-persona-coach helps agents via periodic reflection questions. However, agents can get stuck in behavioral loops — trying different approaches but circling back without progress. Current system has no mechanism to help agents recognize and break these loops.

## Decision

Add loop/stagnation-related questions to the existing Identity Check and Progress Check categories, rather than building a new pattern-detection system. Pure prompt modifications — no code changes.

## Alternatives Considered

1. Full pattern detection system with tool call history — over-engineered for initial approach
2. New dedicated "task_loop" category — introduces new infrastructure without proven need
3. Self-diagnosis text matching — doesn't address problem early enough

## Consequences

- **Positive:** Immediately usable — no code changes, just prompt updates
- **Positive:** Works with existing cadence infrastructure
- **Positive:** Questions are persona-specific (not generic) via coach prompt
- **Risk:** Agent may ignore reflection questions — document for human review, don't force stop
- **Risk:** May not catch all loops — can add pattern detection later if needed

## Verification

⚠️ Unverified — the spec references `types.ts` in agent-persona-coach (`/Users/oleksii.honchar/www/misc/agent-persona-coach`), which is outside the better-opencode workspace. The ADR is accepted and well-argued, but the actual code changes in agent-persona-coach were not verified in this review.

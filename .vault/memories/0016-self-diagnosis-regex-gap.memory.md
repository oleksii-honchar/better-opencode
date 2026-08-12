---
type: memory
title: "Self-Diagnosis Regex Gap — 'Stuck on X' Pattern Not Detected"
createdAt: "2026-08-12T20:00:00Z"
updatedAt: "2026-08-12T20:00:00Z"
tags: [unstuck, self-diagnosis, gotcha, detection]
see_also:
  - "../concepts/0007-unstuck-loop-detection.concept.md"
  - "../adrs/0073-self-diagnosis-threshold-2.adr.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: Self-Diagnosis Regex Gap — 'Stuck on X' Pattern Not Detected

## Fact

The self-diagnosis detection regexes in `loop-detector.ts` do not match the pattern "Stuck on [X]" — they require phrases like "stuck in a loop", "I'm stuck", "repeating the same", or "going in circles". An agent writing "Stuck on sed command" does not trigger self-diagnosis evidence.

## Context

In the sed incident (session `ses_009302293ffe3KacIsKYNnejAD`), the model wrote "Stuck on sed command. Switching to Write." at ~+147s. The `detectSelfDiagnosis` function (loop-detector.ts:18-27) uses these regexes: `/stuck\s+in\s+a\s+loop/i`, `/i['']m\s+stuck/i`, `/repeating\s+the\s+same/i`, `/going\s+in\s+circles/i`, `/cannot\s+(progress|proceed|continue)/i`. None match "Stuck on sed command."

Even if the regex matched, self-diagnosis requires a threshold of 2 (ADR-0073) — a single mention wouldn't trigger intervention anyway.

## Impact

Agents that acknowledge being stuck with shorter phrases like "Stuck on [X]" or "Can't do [Y]" bypass the self-diagnosis detection entirely. The detection only catches verbose self-diagnoses. **Potential improvement:** add a `/stuck\s+on\s+\w+/i` pattern or a general `/\bstuck\b/i` with minimum context length. Also note: self-diagnosis threshold is 2, so even a matching single mention wouldn't intervene — verify threshold semantics for this case.

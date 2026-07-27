---
type: memory
title: "Forked Dynamic Skill Scan Hung and Raced (Fixed by Going Synchronous)"
createdAt: "2026-07-27T18:00:00Z"
updatedAt: "2026-07-27T18:00:00Z"
tags: [dynamic-skills, fork, hang, race-condition, gotcha]
see_also:
  - "adrs/0059-synchronous-scan-decision.adr.md"
  - "adrs/0058-self-inject-pattern.adr.md"
  - "specifications/0011-dynamic-skill-discovery.spec.md"
deprecated:
  date: null
  reason: null
  superseded_by: null
---

# Memory: Forked Dynamic Skill Scan Hung and Raced

## Fact

The dynamic skill scan was forked (`Effect.forkChild`) for non-blocking performance, causing two issues: (1) indefinite hangs on `AppFileSystem.Service` I/O, (2) race conditions between scan completion and injection.

## Context

- **Symptom:** `trigger-prompt` log appeared, then silence — no skills discovered
- **Root cause 1 (hang):** Forked effect + async I/O without timeout = infinite hang
- **Root cause 2 (race):** Forked scan completed asynchronously; injection called before scan finished
- **Impact:** Feature appeared broken in production; 3 live tests failed before root cause identified
- **Detection:** Added trace logs at each scan stage; identified hang between `scan-parts-path-resolved` and `find-agents-dirs-start`
- **Fix:** Removed fork entirely; made scan synchronous (~10-50ms blocking time)

## Impact

**Lesson:** Forked effects are not free — they introduce hangs (if no timeout) and race conditions (if callers depend on completion). When the operation is fast enough (10-50ms), synchronous execution is simpler and more reliable.

**Decision rule:** If an operation takes <100ms and callers need it to complete, prefer synchronous execution over fork + coordination machinery.

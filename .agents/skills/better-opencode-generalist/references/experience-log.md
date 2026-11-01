# Experience Log

Session-tagged lessons learned from fork management. Grows over time.

## Format

```
### {YYYY-MM-DD} — {Short title}
- **Session:** {session ID or description}
- **Context:** What was being done
- **Finding:** What was discovered
- **Action:** What was done to fix/work around it
- **Lesson:** Generalizable takeaway for future work
```

---

### 2026-05-18 — Fork change transfer: patch extraction vs cherry-pick
- **Session:** ses_1c88113c6ffe0erLPM1kJoDy7r (transfer-fork-changes)
- **Context:** Needed to transfer fork features from `260430-feat-01` (merged into `patched/dev`) onto clean upstream base in a separate repo (`better-oc-patched-dev`)
- **Finding:** Old fork commits (e.g., 27387e484 for MCP filtering) conflict heavily with current upstream — cherry-pick fails with many conflicts
- **Action:** Extracted clean diffs from the already-adapted merge commit (927eab170) vs upstream base, then applied as separate per-feature patches on a new branch. Each feature = one commit with descriptive message.
- **Lesson:** When fork commits conflict heavily with upstream, don't cherry-pick old fork commits. Extract diffs from an already-adapted merge commit vs upstream base, then apply as separate patches grouped by feature. This preserves the adaptation work and avoids conflicts.

### 2026-05-18 — Binary file handling in patch extraction
- **Context:** PNG test fixture couldn't be patched via diff (binary file)
- **Action:** Copied directly via `git show 927eab170:path/to/file > path/to/file`
- **Lesson:** When extracting diffs from a commit, binary files need special handling — use `git show` to extract them directly instead of trying to patch.

---

### 2026-10-29 — Session status hoisting and idle-symmetry ownership
- **Session:** ses_e83db2cb0ffefNNsbA2bJLGMal (persona-bootstrap-script, ad-hoc AT-2) — unlanded working-tree change on `patched/dev2`
- **Context:** Client showed nothing during first-turn waits because the first `status.set(busy)` is inside `runLoop` (prompt.ts), which only starts after the awaited `plugin.trigger("chat.message")` and message persistence finish
- **Finding:** Idle cleanup is owned by `SessionRunState`/`Runner` (`runner.ts finishRun` fires `onIdle` on every exit of the loop work; `cancel` lands idle when no busy runner exists). Errors from the message-creation window throw BEFORE any Runner exists — a busy-set hoisted in front of it has no automatic idle path; also `prompt({noReply:true})` (tool/task.ts background injection) never reaches the loop and must not flip status of an already-busy parent session
- **Action:** Set busy at `prompt()` entry (guarded off for `noReply`), and cleared idle via `Effect.onExit` on the `createUserMessage` call only on failure exits; runLoop's per-iteration busy-set untouched (idempotent re-assert)
- **Lesson:** When hoisting a busy signal earlier in a session pipeline, pair it with the exact failure window that precedes the runner's ownership: the Runner's `onExit→onIdle` guarantees do NOT cover pre-`ensureRunning` code, so add a guarded failure-clear there. Check for early-return success paths (like `noReply`) that hand off to no loop — they would otherwise leak a stuck busy.

---

<!-- Add new entries above this line -->

</content>, 
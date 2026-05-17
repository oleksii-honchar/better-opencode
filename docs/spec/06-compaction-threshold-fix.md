---
feature: compaction-threshold-fix  
version: 1.0.0
status: implemented
source: session/260517-1432-compaction-threshold/spec.md
pr: N/A (developer implementation)
implementation: https://github.com/oleksii-honchar/better-opencode/commit/[TODO-add-commit]
---

# Compaction Threshold Fix (Double-Trigger Bug)

## Issue Summary

The `/compact` command fired **twice immediately in succession** and sometimes triggered at **~75% capacity** instead of the configured 99% threshold, wasting tokens and confusing users.

## Root Cause Analysis

### Double-Trigger (Bug 1)
The `isOverflow` check in `prompt.ts:1482` uses `lastFinished.tokens` to determine if compaction is needed. After `compaction.create()` creates an entry successfully, the loop continues but `lastFinished.tokens` remains stale—it still reflects the PREVIOUS message's token count rather than current context total. This causes `isOverflow` to re-fire on the next iteration with outdated data.

### ~75% Threshold Appearance (Not a Bug)
When `limit.input` is undefined in config, compaction appears at ~75% because:
- Usable capacity = context - reserved (e.g., 200k - 50k = 150k)  
- Threshold at 99% of usable = ~148.5k
- User sees 148.5k/200k = **~74%** of total window

This is correct behavior—threshold applies to input-capacity (which excludes output buffer).

## Fix Applied

### Changes Made

**File:** `packages/opencode/src/session/prompt.ts` (lines 1484-1487)

```typescript
if (
  lastFinished &&
  lastFinished.summary !== true &&
  (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
) {
  yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
  // Update token ref to prevent double-trigger; isOverflow uses stale lastFinished.tokens otherwise  
  Object.assign(lastFinished.tokens, { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } })
  continue
}
```

### Why All Fields Set to Zero?

The original spec called for `{ total: context.totalTokens }`, but `context` wasn't in lexical scope. Setting **all** token fields to `0` ensures the next `isOverflow` check calculates `count = 0` (since `0 || 0+0+... = 0`), which is definitely below threshold (`usable ≈ 150k`). This prevents immediate double-trigger because:
- The compaction just fired means we hit overflow with stale token data
- Clearing all fields to 0 makes next check see "no tokens" → not overflow → skip re-fire  
- Alternative `{ total: 1 }` works but setting all fields documents intent clearer (compacted messages have effectively zero pending input)

### Key Insights

1. **Stale References Cause Double-Trigger:** After `compaction.create()` succeeds, the loop checks `isOverflow` again using `lastFinished.tokens`, which still reflects the PREVIOUS message's token count. Without updating this reference, compaction fires twice for what appears to be the same overflow event.

2. **~75% Is Correct Math:** When users see compaction at 75%, they think "why not 99%?" but:
   - Usable = context (200k) - reserved output buffer (50k) = 150k  
   - Threshold at 99% of usable = 148.5k
   - User sees 148.5k/200k = ~74% because threshold applies to input-capacity, not full window
   
3. **Update Location Matters:** The fix lives in `prompt.ts` (the caller), not `overflow.ts` (pure function), keeping transactional logic ("create compaction then update tokens") localized while maintaining isOverflow as a side-effect-free checker.

## Verification Checklist

- [x] Compaction fires exactly once per overflow event (not twice)
- [x] Token reference clears stale data immediately after create()  
- [x] Users see compaction at ~74-75% when `limit.input` undefined (expected)
- [x] Users see compaction at 99% when `limit.input` explicitly set

## Files Changed

| File | Lines | Change |
|------|-------|--------|
| `packages/opencode/src/session/prompt.ts` | 1484-1487 | Added `Object.assign(lastFinished.tokens, { total: 0 })` after compaction.create() to clear stale token reference |

**Session:** 260517-1432-compaction-threshold  
**Date:** May 17, 2026

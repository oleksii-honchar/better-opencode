# 08-unstuck-plugin

## Context

Models (especially reasoning models) can get stuck in loops — repeatedly generating the same text or making the same tool calls with identical inputs. Currently, the only built-in loop detection is the `doom_loop` mechanism in `SessionProcessor`, which only detects repeated **tool calls** (same tool, same input, 3 consecutive times) and prompts the user for permission. There is no mechanism to detect or break **text repetition loops** during streaming, and no way to automatically abort a stuck session.

The existing `doom_loop` mechanism (`DOOM_LOOP_THRESHOLD = 3`) only checks if the **same tool with the same exact input** appears 3 consecutive times within a single message. It does NOT detect:

1. **Same thinking + same tool call** repeating across steps (model slightly varies tool input)
2. **Same reasoning pattern** repeating across steps (model re-thinks the same thing)
3. **Cross-step loops**: thinking → tool call → result → same thinking → same tool call → ...
4. **Repeating sentences within a step**: "Let me check the file" → "I need to read it" → "Let me check the file" → "I need to read it" — same sentence repeating every 1-5 sentences

## Problem

Users need a way to detect and break model loops automatically. The current `doom_loop` only handles exact tool+input matches within a single message, missing broader loop patterns that span steps and include thinking/reasoning text.

## Solution: Unstuck V2 Plugin

The **Unstuck** V2 plugin detects and breaks model loops by wrapping the `LanguageModelV3` via the `aisdk.language` hook. It intercepts every token in the stream and detects loops at three levels:

1. **Step-level**: Same thinking→tool-call pattern repeating across steps
2. **Sentence-level**: Same sentence repeating every N sentences within a single step
3. **Tool-only**: Same tool calls repeating across steps (regardless of thinking)

When a loop is detected, the plugin accumulates **evidence** across detections. A single detection is not enough — the plugin only intervenes when per-type evidence crosses a configurable threshold (default: 2 for step/tool loops, 1 for sentence loops). Below threshold, the stream is restarted with original args (the model may self-correct). Threshold met, the plugin performs **nudge**: aborts the current stream, appends a nudge user message to the unchanged conversation, and restarts the stream with the modified conversation.

> **Doom-loop recovery is now unstuck's domain (since 2026-08-01).** The built-in `doom_loop` permission default changed from `"ask"` to `"allow"` — the permission layer no longer hard-stops on a 3× same-tool-same-input pattern. Instead, unstuck detects the doom-loop at the stream level (on `tool-input-end`, before the processor's permission check runs) and routes it through the existing nudge machinery (see the doom-loop detection, config, logging, and troubleshooting sections below).
>
> **Config migration required:** any explicit `doom_loop: deny` rule in a user's agent config **overrides** the new default and re-introduces the raw `Permission.DeniedError` ("Opencode failed to send message with error: …"). Users with explicit `deny` rules must **remove the `doom_loop:` line** from their agent source files (e.g. `~/Documents/agent-rules-n-skills/agents/`) and redeploy to the effective config (e.g. `~/.config/opencode/agents/`).

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Plugin: Unstuck                           │
│                                                             │
│  aisdk.language hook ──→ LoopDetector state                 │
│                        ├── TextTracker                      │
│                        │   ├── StepTextAccumulator          │
│                        │   ├── SentenceSplitter             │
│                        │   └── normalize + fingerprint      │
│                        ├── ToolCallTracker                  │
│                        │   └── tool signature               │
│                        ├── StepRecord (thinking + tools)    │
│                        ├── SentenceHistory (ring buffer)    │
│                        ├── SequenceHistory (ring buffer)    │
│                        └── LoopDetector                     │
│                            ├── step-level loop?             │
│                            ├── sentence-level loop?         │
│                            └── tool-only loop?              │
└─────────────────────────────────────────────────────────────┘
                               │ wraps
┌─────────────────────────────────────────────────────────────┐
│                    opencode core                             │
│                                                             │
│  LLM.Service ──→ AISDK.language ──→ LanguageModelV3         │
│                                     └── doStream            │
│                                         └── SessionProcessor │
│                                             ├── text-delta   │
│                                             └── tool-call    │
│                                                 └── doom_loop │
└─────────────────────────────────────────────────────────────┘
                               │
┌─────────────────────────────────────────────────────────────┐
│                    Cancel path                               │
│                                                             │
│  abort stream ──→ Error thrown ──→ Effect.Stream error      │
│                     └── AbortController.abort               │
│                         └── SessionRunState.cancel          │
└─────────────────────────────────────────────────────────────┘
                               │
┌─────────────────────────────────────────────────────────────┐
│                    Nudge path                                │
 │                                                             │
 │  LoopDetectedError ──→ Abort current stream                 │
 │                     └── Append nudge user message:          │
 │                         "You are stuck in a loop —          │
 │                          break out and take a different     │
 │                          direction."                        │
 │                     └── Restart: call original doStream     │
 │                         with unchanged messages + nudge     │
 │                     └── If maxNudges exceeded → abort       │
└─────────────────────────────────────────────────────────────┘
```

### Component Design

#### 1. Integration Point — `provider.ts`

The Unstuck plugin is integrated directly in `provider.ts` at the `getLanguage()` method. The V2 `PluginV2.define()` approach was evaluated but not used — the `aisdk.language` hook is not wired up in the current codebase.

```typescript
// In provider.ts:
const config = yield* Config.Service.get()
const unstuckConfig = mergeConfig(config.unstuck ?? {})
const detector = new LoopDetectorImpl()
const wrapped = wrapWithLoopDetection(language, detector, unstuckConfig)
```

The `LoopDetectorImpl` instance is cached per model (via `s.models.set(key, wrapped)`), which is correct — the detector persists across calls within the same model instance.

#### 2. `wrapWithLoopDetection` — LanguageModelV3 Wrapper

Wraps the original `LanguageModelV3` and intercepts `doStream` to observe every token. Uses **evidence accumulation**: on detection, adds evidence and checks per-type threshold. Below threshold: resets streaming state and restarts (model may self-correct). Threshold met: performs nudge (appends guidance message, no pruning).

```typescript
function wrapWithLoopDetection(model, detector, config) {
  let nudgeCount = 0  // Track nudges per conversation
  const evidence = new EvidenceAccumulatorImpl(config.evidenceWindow)

  return {
    ...model,
    async *doStream(args) {
      while (true) {
        try {
          const originalStream = model.doStream(args)
          let chunkCount = 0
          for await (const chunk of originalStream) {
            // Intercept each chunk
            const loopInfo = detector.consumeChunk(chunk, config)
            if (loopInfo) {
              // Add evidence
              evidence.add(loopInfo, chunkCount)

              // Check threshold
              if (!shouldIntervene(evidence, config)) {
                // Below threshold — reset streaming state, restart with original args
                detector.reset()  // clears currentThinking/tools, preserves history
                yield* model.doStream(args)
                continue  // back to top of while loop
              }

               // Threshold met — proceed to nudge
              throw new LoopDetectedError(loopInfo)
            }
            yield chunk
            chunkCount++
          }
          // Clean finish — clear evidence and detector
          evidence.clear()
          detector.clear()
          return
        } catch (error) {
          if (!(error instanceof LoopDetectedError)) throw error

          // --- Warn / Abort modes ---
          if (config.strategy === "warn") {
            console.warn("[unstuck] Loop detected (warn mode):", error.info)
            throw error
          }

          if (nudgeCount >= config.maxNudges) {
            console.error("[unstuck] Max nudges reached, aborting")
            throw error
          }

          nudgeCount++

          // Use original messages (no pruning)
          const originalMessages = args.messages

          // Inject nudge user message
          const nudgedMessages = [
            ...originalMessages,
            {
              role: "user",
              content: config.nudgeMessage ??
                "You appear to be stuck in a loop — repeating the same thinking or tool calls. " +
                "Break out of the pattern and take a different direction.",
              _unstuckNudge: true,  // Marker for debugging
            },
          ]

          // Clear evidence and detector for fresh episode
          evidence.clear()
          detector.clear()

          // Restart with modified messages — goes back to top of while loop
          args = { ...args, messages: nudgedMessages }
        }
      }
    },
  }
}
```

#### 3. `LoopDetector` — Core Detection Engine

Tracks the sequence of thinking output and tool calls across steps. Maintains a ring buffer of recent step records.

```typescript
interface StepRecord {
  thinkingFingerprint: string
  toolSignatures: string[]
  stepFingerprint: string
}

interface LoopDetector {
  consumeChunk(chunk: StreamChunk, config: UnstuckConfig): LoopDetectedInfo | undefined
  onStepComplete(): void
  reset(): void
  getState(): DetectorState
}

class LoopDetectorImpl implements LoopDetector {
  private currentThinking = ""
  private currentTools: string[] = []
  private history: StepRecord[] = []
  private inReasoning = false

  consumeChunk(chunk, config) {
    switch (chunk.type) {
      case "reasoning-delta":
        this.currentThinking += chunk.text
        break
      case "text-delta":
        this.currentThinking += chunk.text
        break
      case "tool-input-end":
        const sig = this.computeToolSignature(chunk)
        this.currentTools.push(sig)
        break
      case "finish-step":
        this.finalizeStep(config)
        break
    }
    return undefined
  }

  finalizeStep(config) {
    const thinkingFp = this.normalizeAndFingerprint(this.currentThinking)
    const stepFp = this.computeStepFingerprint(thinkingFp, this.currentTools)

    const record: StepRecord = {
      thinkingFingerprint: thinkingFp,
      toolSignatures: [...this.currentTools],
      stepFingerprint: stepFp,
    }

    this.history.push(record)
    if (this.history.length > config.historySize) {
      this.history.shift()
    }

    const loopInfo = this.detectLoop(config)
    if (loopInfo) return loopInfo

    this.currentThinking = ""
    this.currentTools = []
  }

  detectLoop(config) {
    // Step-level loop
    const window = config.loopThreshold
    if (this.history.length < window) return undefined

    const recent = this.history.slice(-window)
    const first = recent[0].stepFingerprint
    if (recent.every(r => r.stepFingerprint === first)) {
      return { type: "step_loop", threshold: window, fingerprint: first, steps: recent }
    }

    // Tool-only loop
    if (config.detectToolOnlyLoops) {
      const toolWindow = config.toolLoopThreshold
      if (this.history.length < toolWindow) return undefined

      const recentTools = this.history.slice(-toolWindow)
      const allSameTools = recentTools.every(r =>
        arraysEqual(r.toolSignatures, recentTools[0].toolSignatures)
      )
      if (allSameTools && recentTools[0].toolSignatures.length > 0) {
        return { type: "tool_loop", threshold: toolWindow, steps: recentTools }
      }
    }

    return undefined
  }

  normalizeAndFingerprint(text: string): string {
    const normalized = text
      .toLowerCase()
      .replace(/[\s]+/g, " ")
      .replace(/[.,!?;:()\[\]{}"']/g, "")
      .trim()
    return hash(normalized)  // SHA-256, truncated to 16 chars
  }

  computeToolSignature(toolEvent): string {
    const toolName = toolEvent.toolName.toLowerCase()
    const inputKeys = toolEvent.input
      ? Object.keys(toolEvent.input).sort().join(",")
      : ""
    return `${toolName}:${inputKeys}`
  }

  computeStepFingerprint(thinkingFp: string, toolSigs: string[]): string {
    return `${thinkingFp}|${toolSigs.join(";")}`
  }

  reset() {
    // Only clears streaming state — preserves history for evidence accumulation
    this.currentThinking = ""
    this.currentTools = []
    // history is preserved
    this.sentenceTracker.reset()
  }

  clear() {
    // Clears everything — used after nudge fires or clean stream finish
    this.currentThinking = ""
    this.currentTools = []
    this.history = []
    this.sentenceTracker.reset()
  }
}
```

#### 4. `LoopDetectedError` — Abort Signal

```typescript
class LoopDetectedError extends Error {
  constructor(public info: LoopDetectedInfo) {
    super(`Model loop detected: ${info.type} (threshold: ${info.threshold})`)
    this.name = "LoopDetectedError"
  }
}

interface LoopDetectedInfo {
  type: "step_loop" | "tool_loop" | "sentence_loop"
  threshold: number
  fingerprint?: string
  sentence?: string  // for sentence_loop
  steps: StepRecord[]
}
```

### Loop Detection Algorithm

#### What constitutes a "loop"

A loop is detected when the **same step fingerprint** appears `threshold` consecutive times in the history. A step fingerprint is computed from:

1. **Thinking fingerprint**: The normalized + hashed thinking/reasoning text for the step
2. **Tool signatures**: The sequence of tool calls (tool_name + input_keys) for the step

```
step_fingerprint = hash(thinking_normalized) | tool_sig_1;tool_sig_2;...
```

#### Normalization

To handle slight variations in model output:

1. **Text normalization**: lowercase, collapse whitespace, strip punctuation
2. **Fingerprinting**: SHA-256 hash of normalized text (truncated to 16 chars)
3. **Tool signature**: tool_name (lowercase) + sorted key=value pairs (values are normalized: lowercase, collapsed whitespace, stripped quotes). This avoids false positives where different commands/files matched the same signature (e.g., `bash:command=./script.sh` vs `bash:command=ls -la`).

#### Detection modes

1. **Full step loop** (default): Same thinking + same tools repeating
   - Threshold: configurable (default: 3)
   - Compares full step fingerprint

2. **Tool-only loop** (optional): Same tools repeating, regardless of thinking
   - Threshold: configurable (default: 4, higher to avoid false positives)
   - Only compares tool signatures

3. **Sentence-level loop** (optional): Same sentence repeating every N sentences within a step
   - Threshold: configurable (default: 2)
   - Uses sentence splitter + ring buffer

### Nudge Strategy (Evidence-Based)

The plugin uses **evidence accumulation** before intervening. A single detection is not enough to trigger a nudge — the plugin accumulates `EvidenceRecord` observations across detections and only intervenes when per-type evidence crosses a confidence threshold. This prevents false positives from consuming the nudge budget.

```
Detect → evidence++ → if evidence < threshold: continue stream (model may self-correct)
                        else: append nudge user message and restart with unchanged messages
```

#### Evidence Data Model

Each detection adds an `EvidenceRecord`:

```typescript
interface EvidenceRecord {
  type: "step_loop" | "tool_loop" | "sentence_loop"
  fingerprint?: string
  sentence?: string
  threshold: number
  detectedAtChunk: number
  steps?: StepRecord[]
  timestamp: number
}
```

Evidence is **scoped by loop type** — a `step_loop` detection doesn't count toward the `sentence_loop` threshold. Evidence clears after a nudge fires or after a clean stream finish.

#### Intervention Flow

1. **Detection** — The detector returns `LoopDetectedInfo`. The wrapper converts it to an `EvidenceRecord` and appends it to the accumulator.
2. **Threshold check** — `evidence.countByType(type) >= evidenceThresholds[type]`?
   - **Below threshold**: Call `detector.reset()` (clears streaming state, preserves history), restart the stream with original args. The model may self-correct.
    - **Threshold met**: Proceed to nudge (step 3).
3. **Nudge** — Abort the current stream, append nudge user message, restart the stream with unchanged messages plus the nudge.
4. **Clear** — After nudge fires, call `detector.clear()` and `evidence.clear()` — both start fresh for the next episode.
5. **Fallback** — If `maxNudges` (default: 2) is exceeded across the session, fall back to abort.

#### `detector.reset()` vs `detector.clear()`

| Method | When Called | Clears History? |
|--------|-------------|-----------------|
| `reset()` | After detection below threshold (continue stream) | No — keeps history for evidence within the same stream |
| `clear()` | After nudge fires OR after clean stream finish | Yes — starts fresh |

#### Interaction with `maxNudges`

`maxNudges` is the **ultimate safety net** across the session. Evidence accumulation determines **when** within a stream to intervene:

```
maxNudges = 2, evidenceThresholds.stepLoop = 2

Stream 1: detection → evidence=1 → continue
          detection → evidence=2 → threshold met → nudge #1 → evidence cleared

Stream 2: detection → evidence=1 → continue (fresh evidence)
          detection → evidence=2 → threshold met → nudge #2 → evidence cleared

Stream 3: detection → evidence=1 → continue (fresh evidence)
          detection → evidence=2 → threshold met → would nudge
          but nudgeCount (2) >= maxNudges (2) → ABORT
```

#### Backward Compatibility

To preserve the old immediate-nudge behavior, set all thresholds to `1`:

```json
{
  "unstuck": {
    "evidenceThresholds": {
      "stepLoop": 1,
      "toolLoop": 1,
      "sentenceLoop": 1
    }
  }
}
```

### Configuration Schema

```typescript
interface EvidenceThresholds {
  stepLoop: number       // default: 2 — two step_loop detections before nudge
  toolLoop: number       // default: 2 — two tool_loop detections before nudge
  sentenceLoop: number   // default: 1 — one sentence_loop detection triggers nudge
  doomLoop?: number      // default: 1 — one doom_loop detection triggers nudge
}

interface UnstuckConfig {
  enabled: boolean
  loopThreshold: number  // default: 3
  detectToolOnlyLoops: boolean  // default: true
  toolLoopThreshold: number  // default: 6
  historySize: number  // default: 10
  minThinkingLength: number  // default: 50
  includeReasoning: boolean  // default: true
  includeText: boolean  // default: true

  // Doom-loop detection (3× same tool + exact input within a step)
  enableDoomLoopDetection: boolean  // default: true
  doomLoopThreshold: number         // default: 3 (matches DOOM_LOOP_THRESHOLD)

  // Sentence-level loop detection
  enableSentenceLoopDetection: boolean  // default: true
  sentenceLoopThreshold: number         // default: 3
  minSentenceLength: number             // default: 15

  // Evidence-based intervention thresholds (per loop type)
  evidenceThresholds?: EvidenceThresholds  // default: { stepLoop: 2, toolLoop: 2, sentenceLoop: 1 }

  // Maximum evidence records to retain per episode (default: Infinity — no windowing)
  evidenceWindow?: number

  // Nudge settings
  strategy: "nudge" | "nudge-and-prune" | "abort" | "warn"  // default: "nudge"
  maxNudges: number  // default: 2
  nudgeMessage?: string  // default: "You appear to be stuck in a loop..."
  logLevel: "debug" | "info" | "warn"  // default: "info"
}
```

### Config Key Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch. When `false`, the plugin does not wrap the model stream at all. Set to `false` to disable loop detection without removing the config. |
| `loopThreshold` | number | `3` | Number of consecutive steps with identical step fingerprints that trigger a **step_loop** detection. A step fingerprint combines the normalized thinking text hash and the sequence of tool call signatures. |
| `detectToolOnlyLoops` | boolean | `true` | When `true`, also detects **tool_loop** events where the same tool call sequence repeats across steps, even if the thinking text differs. Set to `false` to disable tool-only detection (reduces false positives). |
| `toolLoopThreshold` | number | `6` | Number of consecutive steps with identical tool call signatures that trigger a **tool_loop** detection. This is the **detection threshold** — how many matching steps the detector must see before it fires a single `LoopDetectedInfo`. Higher than `loopThreshold` because tool-only detection is more prone to false positives (the model may legitimately call the same tool with different reasoning). **Distinct from `evidenceThresholds.toolLoop`**: `toolLoopThreshold` controls *detection sensitivity* (how many steps to flag as a loop); `evidenceThresholds.toolLoop` controls *intervention confidence* (how many detected loops before nudging). |
| `historySize` | number | `10` | Size of the ring buffer that stores recent step records. The detector only looks at the last N steps for loop patterns. Larger values allow detection of longer loops but use slightly more memory. |
| `minThinkingLength` | number | `50` | Minimum number of characters in the thinking/reasoning text before the step is considered for fingerprinting. Steps with very short thinking (e.g., "OK", "Sure") are skipped to avoid false positives from trivial responses. |
| `includeReasoning` | boolean | `true` | When `true`, include reasoning-delta (reasoning text) chunks in the step fingerprint. Set to `false` to only use text-delta chunks — useful if you only want to detect loops in the visible output, not the internal reasoning. |
| `includeText` | boolean | `true` | When `true`, include text-delta (visible output) chunks in the step fingerprint. Set to `false` to only use reasoning text. In practice, keep this `true` — the model's visible output is what matters for loop detection. |
| `enableSentenceLoopDetection` | boolean | `true` | When `true`, detect **sentence_loop** events where the same sentence repeats every 1–5 sentences within a single step (e.g., "Let me check the file" appearing 3+ times with periodic spacing). Set to `false` to disable sentence-level detection. |
| `sentenceLoopThreshold` | number | `3` | Number of periodic repetitions of the same sentence that triggers a **sentence_loop** detection. The sentence must repeat with consistent spacing (within ±1 sentence of the previous gap). |
| `minSentenceLength` | number | `15` | Minimum number of characters in a sentence before it is considered for loop detection. Short fragments (e.g., "OK", "Hmm") are excluded to avoid false positives from common words. |
| `enableDoomLoopDetection` | boolean | `true` | When `true`, unstuck also detects **doom_loop** events: the same tool called with the exact same input `doomLoopThreshold` consecutive times within the current step (mirroring the processor's built-in `doom_loop` check, `DOOM_LOOP_THRESHOLD = 3`). Detection fires at the stream level on `tool-input-end`, **before** the processor's `doom_loop` permission check runs. Set to `false` to disable doom-loop detection (the processor's `doom_loop` permission then governs — default `allow`). |
| `doomLoopThreshold` | number | `3` | Number of consecutive identical (tool name + exact `JSON.stringify(input)`) calls within the current step that trigger a single `doom_loop` detection. Matches the built-in `DOOM_LOOP_THRESHOLD`. **Distinct from `evidenceThresholds.doomLoop`**: `doomLoopThreshold` controls *detection* (how many identical calls to flag as a loop); `evidenceThresholds.doomLoop` controls *intervention* (how many detected doom loops before nudging). |
| `evidenceThresholds` | object | `{ stepLoop: 2, toolLoop: 2, sentenceLoop: 1, doomLoop: 1 }` | Per-type evidence accumulation thresholds. Each detection adds one `EvidenceRecord`; the nudge only fires when `countByType(type) >= evidenceThresholds[type]`. **Why different from `toolLoopThreshold`**: `toolLoopThreshold` controls *detection* (how many matching steps to flag as a loop); `evidenceThresholds.toolLoop` controls *intervention* (how many detected loops before nudging). Example: `toolLoopThreshold: 8` means 8 consecutive matching tool steps trigger one detection; `evidenceThresholds.toolLoop: 2` means you need 2 such detections before a nudge fires. This two-stage gating prevents false positives from consuming the nudge budget. |
| | | | - **`stepLoop`** (default: 2): Step loops are strong signals (same thinking + same tools), but one false positive can happen if the model legitimately revisits a pattern. Two confirms it's stuck. |
| | | | - **`toolLoop`** (default: 2): Same reasoning as step loops. |
| | | | - **`sentenceLoop`** (default: 1): Sentence loops are very strong signals — the detector already requires `sentenceLoopThreshold` repetitions within the stream, so by the time it fires, confidence is high. |
| | | | - **`doomLoop`** (default: 1): Doom loops are very strong signals — the detector already requires `doomLoopThreshold` identical calls, so a single detection already proves 3 identical calls occurred. |
| | | | To restore the old immediate-nudge behavior, set all to `1`. |
| `evidenceWindow` | number | `Infinity` | Maximum evidence records to retain per episode (stream between nudges). Older records are evicted when new ones are added. Default `Infinity` means no windowing — all evidence persists until cleared by a nudge or clean finish. Set a finite value (e.g., `10`) for memory bounds in very long sessions. |
| `strategy` | `"nudge" \| "nudge-and-prune" \| "abort" \| "warn"` | `"nudge"` | What to do when a loop is detected: |
| | | | - **`nudge`** (default): Abort the stream, append a nudge user message to the unchanged conversation, and restart the stream. No messages are removed. |
| | | | - **`nudge-and-prune`** (deprecated alias for `nudge`): Same as `nudge`. This alias is kept for backward compatibility. |
| | | | - **`abort`**: Abort the stream immediately. No recovery attempt. The session turns red with an error. |
| | | | - **`warn`**: Log a warning about the loop but do **not** abort or nudge. Useful for debugging or when you want manual review before intervention. |
| `maxNudges` | number | `2` | Maximum number of nudge recovery attempts before falling back to abort. If the model re-enters the same loop after a nudge, the plugin will try again up to this limit. After `maxNudges` failures, the stream is aborted. |
| `nudgeMessage` | string | auto-generated | Custom nudge message injected as a synthetic user message when a loop is detected. The auto-generated message is: "You appear to be stuck in a loop — repeating the same thinking or tool calls. Break out of the pattern and take a different direction." Set a custom value to match your team's communication style. |
| `logLevel` | `"debug" \| "info" \| "warn"` | `"info"` | Log level for unstuck plugin events. Use `debug` for per-chunk state tracking (text accumulated, fingerprints computed, sentence splits) — useful for diagnosing false positives. Use `info` for loop detection events and nudge actions. Use `warn` to only see warnings (max nudges reached). |

### Configuration via opencode config

```json
{
  "unstuck": {
    "enabled": true,
    "loopThreshold": 3,
    "detectToolOnlyLoops": true,
    "toolLoopThreshold": 6,
    "historySize": 10,
    "minThinkingLength": 50,
    "enableSentenceLoopDetection": true,
    "sentenceLoopThreshold": 3,
    "minSentenceLength": 15,
    "enableDoomLoopDetection": true,
    "doomLoopThreshold": 3,
    "evidenceThresholds": {
      "stepLoop": 2,
      "toolLoop": 2,
      "sentenceLoop": 1,
      "doomLoop": 1
    },
    "evidenceWindow": 10,
    "strategy": "nudge",
    "maxNudges": 2
  }
}
```

### Understanding `toolLoopThreshold` vs `evidenceThresholds.toolLoop`

These two settings work together in a **two-stage gating** pattern:

```
Stage 1 — Detection (toolLoopThreshold):
  6 consecutive steps with same tool signatures → 1 detection event

Stage 2 — Intervention (evidenceThresholds.toolLoop):
  2 detection events accumulated → nudge fires
```

**`toolLoopThreshold`** (detection sensitivity):
- Controls how many consecutive matching steps the detector must see before it fires a single `LoopDetectedInfo` of type `tool_loop`.
- Higher value = fewer detections (less sensitive). Lower value = more detections (more sensitive).
- Default: `6` (a reasonable middle ground between `4` and `8`, reduces false positives while maintaining sensitivity).

**`evidenceThresholds.toolLoop`** (intervention confidence):
- Controls how many `tool_loop` detection events must accumulate before a nudge fires.
- Higher value = more patience (model gets more chances to self-correct). Lower value = quicker intervention.
- Default: `2` (need 2 confirmed detections before nudging).

**Why two stages?** With the old single-stage approach, every detection immediately fired a nudge. False positives consumed the nudge budget before a real loop ever got addressed. With two stages, a false positive detection just adds one piece of evidence — it takes `evidenceThresholds.toolLoop` false positives before a nudge fires, and even then the model might self-correct between detections.

**Example scenario:**

```
toolLoopThreshold: 6, evidenceThresholds.toolLoop: 2

Steps 1-5: model edits 5 different files (different signatures, no match)
Steps 6-11: model enters a real loop (same edit, 6 steps → detection #1, evidence=1)
Steps 12-17: model continues looping (6 more steps → detection #2, evidence=2 → threshold met → nudge fires)
```

**To restore old immediate-nudge behavior:**

```json
{
  "unstuck": {
    "evidenceThresholds": {
      "stepLoop": 1,
      "toolLoop": 1,
      "sentenceLoop": 1
    }
  }
}
```

### Log Filtering

The unstuck plugin emits structured logs tagged with `service: "unstuck"`. Use `grep` or `rg` to filter logs for loop detection events.

#### Log Levels and What They Emit

| Level | What is logged | Example |
|-------|---------------|---------|
| DEBUG | Per-chunk state: text accumulated, tool call received, sentence split result, fingerprint value | `log.debug("chunk processed", { type: "text-delta", accumulatedLen: 234 })` |
| DEBUG | Sentence-level detection: sentence added to history, periodic pattern check | `log.debug("sentence tracked", { index: 5, hash: "a1b2c3", window: 7 })` |
| INFO | Loop detected: type, threshold, fingerprint (or repeating sentence for sentence_loop) | `log.info("loop detected", { type: "step_loop", threshold: 3, fingerprint: "..." })` or `log.info("loop detected", { type: "sentence_loop", threshold: 3, sentence: "Let me check..." })` |
| INFO | Nudge event: nudge number, restart | `log.info("nudge applied", { nudgeCount: 1, strategy: "nudge" })` |
| WARN | Max nudges reached, falling back to abort | `log.warn("max nudges reached", { maxNudges: 2, fallback: "abort" })` |
| ERROR | Unexpected error during stream interception | `log.error("stream wrap error", { error: e.message })` |
| DEBUG | **L1 — doom_loop candidate tracked**: each `tool-input-end` matching the current doom-loop run (tool name + exact input) | `log.debug("doom_loop candidate tracked", { toolName: "bash", candidateCount: 2, inputFingerprint: "a1b2c3d4e5f6a1b2", currentRun: 1 })` |
| INFO | **L2 — doom_loop detected**: 3rd identical call seen and the evidence threshold is met | `log.info("doom_loop detected", { type: "doom_loop", threshold: 3, toolName: "bash", inputFingerprint: "a1b2c3d4e5f6a1b2", chunkCount: 42 })` |
| DEBUG | **L3 — doom_loop input equality mismatch**: a later call in the run differs → run broken (false-negative diagnostic) | `log.debug("doom_loop input equality mismatch", { toolName: "bash", expectedInputFingerprint: "a1b2c3d4e5f6a1b2", actualInputFingerprint: "c3d4e5f6a7b8c9d0" })` |
| DEBUG | **L4 — doom_loop skipped**: input resolution failed / `_missing` / provider-executed | `log.debug("doom_loop skipped", { toolName: "bash", reason: "missing-input" })` |
| INFO | **L5 — nudge applied** (doom_loop): nudge fired for the detected doom loop | `log.info("nudge applied", { nudgeCount: 1, loopType: "doom_loop", toolName: "bash" })` |
| WARN | **L6 — max nudges reached, aborting**: the doom loop still recurs after `maxNudges` nudges | `log.warn("max nudges reached, aborting", { maxNudges: 2, type: "doom_loop", toolName: "bash" })` |
| DEBUG | **L7 — doom_loop config**: emitted once on wrapper init | `log.debug("doom_loop config", { enableDoomLoopDetection: true, doomLoopThreshold: 3, evidenceDoomLoop: 1 })` |

#### Log Commands

```bash
# Show all unstuck logs (any level)
grep -i "service.*unstuck" ~/.opencode/logs/* 2>/dev/null || \
  grep -i "service.*unstuck" ~/.opencode/opencode.log 2>/dev/null

# Show only loop detection events (INFO level)
./scripts/start-dev.sh --server-logs | grep -i "service.*unstuck" | grep -i "loop detected"
grep -i "service.*unstuck" ~/.opencode/logs/* 2>/dev/null | \
  grep -i "loop detected"

# Show only nudge events
grep -i "service.*unstuck" ~/.opencode/logs/* 2>/dev/null | \
  grep -i "nudge"

# Show warnings (max nudges reached)
grep -i "service.*unstuck" ~/.opencode/logs/* 2>/dev/null | \
  grep -i "max nudges"

# Show only debug logs (requires logLevel: "debug" in config)
grep -i "service.*unstuck" ~/.opencode/logs/* 2>/dev/null | \
  grep -i "debug"
```

#### Configuring Log Verbosity

Set `logLevel` in the `unstuck` config section of `opencode.json`:

```json
{
  "unstuck": {
    "logLevel": "debug"  // Options: "debug" | "info" | "warn"
  }
}
```

- **`info`** (default): Only loop detection events and nudge actions. Quiet in production.
- **`debug`**: Per-chunk state tracking (text accumulated, fingerprints computed, sentence splits). Useful for diagnosing false positives.
- **`warn`**: Only warnings (max nudges reached). Most quiet.

#### Troubleshooting with Logs

**Scenario 1: Loop not detected**

```bash
# Enable debug logging
grep -i "service.*unstuck" ~/.opencode/logs/* 2>/dev/null | \
  grep -i "chunk processed"

# Check: is the plugin seeing the chunks?
# If no "chunk processed" logs, the plugin may be disabled or not wrapping the stream.
# Check: "unstuck disabled, passing through" in the logs.

# Check: are fingerprints being computed?
grep -i "service.*unstuck" ~/.opencode/logs/* 2>/dev/null | \
  grep -i "finalizeStep"

# If fingerprints are computed but no loop detected, the threshold may be too high.
# Lower `loopThreshold` or `historySize` and retry.
```

**Scenario 2: False positive — legitimate response aborted**

```bash
# Enable debug logging
grep -i "service.*unstuck" ~/.opencode/logs/* 2>/dev/null | \
  grep -i "loop detected"

# Check: what type of loop was detected?
# If "sentence_loop" was triggered, the model may be legitimately repeating a sentence.
# Increase `sentenceLoopThreshold` (e.g., from 3 to 5) or disable sentence detection.

# If "step_loop" was triggered, the model may be making legitimate progress with similar steps.
# Increase `loopThreshold` (e.g., from 3 to 4) or increase `minThinkingLength` to require more thinking text.
```

**Scenario 3: Nudge not recovering**

```bash
# Check nudge events
grep -i "service.*unstuck" ~/.opencode/logs/* 2>/dev/null | \
  grep -i "nudge"

# Check: how many nudge attempts were made?
# If `maxNudges` was reached, the model is not recovering.
# Consider: increasing `maxNudges`, or switching `strategy` to "abort" to fail fast.
# The nudge message is injected as a synthetic user message in the conversation.
# Look for `"_unstuckNudge": true` in the conversation history to see what was injected.
```

**Doom-loop (doom_loop) troubleshooting** — filter with `rg 'service.*unstuck-plugin' ~/.opencode/logs/* | rg doom_loop` (spec §5a runbook).

**Scenario 4: No nudge happened for a doom loop**

```bash
rg 'service.*unstuck-plugin' ~/.opencode/logs/* | rg doom_loop

# Check L4 ("doom_loop skipped") and L7 ("doom_loop config").
# If `enableDoomLoopDetection: false` or `doomLoopThreshold != 3`, config is the cause —
# enable detection and/or restore the threshold, then retry.
```

**Scenario 5: Nudge happened but the doom loop recurred**

```bash
rg 'service.*unstuck-plugin' ~/.opencode/logs/* | rg 'nudge applied|max nudges reached'

# Check L5 `nudgeCount` against L6 — are we aborting after `maxNudges`?
# If the model re-loops after a nudge, increase `maxNudges` or improve the
# `nudgeMessage` guidance so the model changes approach.
```

**Scenario 6: False positive — nudge on legitimate 3× identical calls**

```bash
rg 'service.*unstuck-plugin' ~/.opencode/logs/* | rg 'doom_loop candidate tracked|doom_loop detected'

# Check L1 `candidateCount` and L2 — if the inputs are genuinely identical 3×, the
# pattern matches the processor's `doom_loop` semantics by design (same tool, same
# exact input, 3 consecutive times). If too aggressive, disable via
# `enableDoomLoopDetection: false`.
```

**Scenario 7: Raw DeniedError still occurs**

```bash
rg 'service.*unstuck-plugin' ~/.opencode/logs/* | rg doom_loop

# Check for `doom_loop: deny` in the effective ruleset — the config migration was
# NOT applied, so the processor's check resolves to `deny` and unstuck never sees
# the call. Unstuck logs will be absent for that path (interception happens only
# when unstuck owns the check). Apply the migration (Scenario 8).
```

**Scenario 8: Config migration — explicit `doom_loop: deny` rules**

The new default permission is `doom_loop: "allow"`, so **no explicit `doom_loop` rule
is needed**. Any explicit `doom_loop: deny` in a user's agent config overrides the
default and re-introduces the raw `DeniedError`. To migrate:

1. **Remove** the `doom_loop:` line from the agent **source** files (e.g.
   `~/Documents/agent-rules-n-skills/agents/` — both `opencode/` and
   `caveman-opencode/`).
2. **Redeploy** the source to the effective config (`~/.config/opencode/agents/`).
3. Verify: `rg doom_loop ~/.config/opencode/agents/` returns nothing, then reproduce
   the doom-loop scenario — a nudge should appear instead of the raw error.


#### Log Format

All unstuck logs are emitted via `@opencode-ai/core/util/log` with:

```typescript
Log.create({ service: "unstuck" })
```

This produces logs tagged with `"service": "unstuck"` in the service field, making it easy to filter:

```bash
# Using ripgrep (rg) for structured log filtering
rg 'service.*"unstuck"' ~/.opencode/logs/* 2>/dev/null
```

The global log level is controlled via opencode config (`logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR"`) or CLI flag (`--log-level DEBUG`). The `logLevel` field in `UnstuckConfig` acts as a **local override** — even if the global log level is DEBUG, the plugin can choose to log at its own level.

---

### Error Handling and Edge Cases

1. **Stream already aborted**: Check `AbortSignal.aborted` before throwing
2. **Partial step at stream end**: Finalize current step with whatever was accumulated
3. **Empty thinking text**: Skip fingerprinting if text < `minThinkingLength`, only check tool signatures
4. **No tool calls in step**: Only check thinking fingerprint
5. **Mixed reasoning and text**: Concatenate reasoning first, then text
6. **Provider-executed tools**: Exclude from loop detection
7. **Compaction steps**: Exclude from loop detection
8. **False positive prevention**: `minThinkingLength` filter, higher threshold for tool-only loops, tool signature uses normalized key=value pairs (not just keys), evidence accumulation requires multiple detections before intervention

### Implementation Plan

#### Phase 1: Core Detection Engine
- [ ] Implement `LoopDetector` class with `consumeChunk`, `finalizeStep`, `detectLoop`
- [ ] Implement `normalizeAndFingerprint` and `computeToolSignature`
- [ ] Implement `LoopDetectedError`
- [ ] Write unit tests for detection logic

#### Phase 2: V2 Plugin Integration
- [ ] Implement `UnstuckPlugin` with `aisdk.language` hook
- [ ] Implement `wrapWithLoopDetection` to wrap `LanguageModelV3`
- [ ] Implement `UnstuckConfig` service and configuration loading
- [ ] Write integration tests with mock `LanguageModelV3`

#### Phase 3: Nudge Integration
- [ ] Implement nudge message injection
- [ ] Implement `doStream` restart logic with modified messages
- [ ] Implement `maxNudges` fallback to abort
- [ ] Write end-to-end tests with real stream

#### Phase 4: Polish and Edge Cases
- [ ] Handle partial steps at stream end
- [ ] Handle provider-executed tools
- [ ] Handle compaction steps
- [ ] Add logging and debugging output
- [ ] Add configuration UI (if applicable)

### Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **False positive abort** — legitimate response aborted | High | Evidence accumulation (default: 2 detections before nudge), higher thresholds for tool-only loops, `minThinkingLength` filter, tool signatures include values, configurable `strategy: "warn"` mode |
| **Performance overhead** — fingerprinting every chunk | Low | Fingerprinting only at step boundaries, not per-chunk; SHA-256 is fast for small strings |
| **Memory leak** — history ring buffer grows | Low | Ring buffer with configurable size, old entries evicted |
| **Breaks existing doom_loop** — conflicts with existing detection | Medium | Unstuck operates at a different level (step-level vs part-level); they complement each other |
| **Provider-specific behavior** — some providers don't emit finish-step | Medium | Handle partial steps; fall back to stream end as step boundary |
| **Nudge causes new loop** — model ignores nudge and loops again | Medium | `maxNudges` limit (default: 2) before falling back to abort |

### Key Decisions

1. **V2 `aisdk.language` hook over V1 `event` hook** — Full control over streaming, can intercept every token, can abort directly
2. **Multi-level detection** — Step-level, sentence-level, and tool-only modes cover different loop patterns
3. **Fingerprint-based comparison over exact matching** — Handles slight model output variations via normalization + SHA-256 hash
4. **Tool signature uses normalized key=value pairs** — Avoids false positives where different commands/files matched the same signature (e.g., `bash:command=./script.sh` vs `bash:command=ls -la`). Values are normalized (lowercase, collapsed whitespace, stripped quotes).
5. **Evidence-based nudge over immediate nudge** — A single detection is not enough to trigger a nudge. Evidence accumulates across detections; nudge only fires when per-type threshold is met. The nudge appends a guidance message to the unchanged conversation — no pruning. This prevents false positives from consuming the nudge budget. `maxNudges` remains as the ultimate safety net.
6. **`reset()` vs `clear()` distinction** — `reset()` only clears streaming state (preserves history for evidence accumulation within a stream). `clear()` wipes everything (used after nudge fires or clean finish).
7. **Separate plugin over modifying existing `doom_loop`** — Different detection levels, complementary mechanisms, no risk of breaking existing behavior
8. **`provider.ts` integration over V2 plugin hook** — The V2 `aisdk.language` hook is not wired up in the current codebase. `provider.ts` is the active hot path. The V2 plugin module remains as a library of utilities (config types, LoopDetectorImpl, wrapWithLoopDetection, etc.) that can be reused if the V2 system gets wired up in the future.

---

**Related**: Session `260519-1341-unstuck-plugins` at `~/.agent-sessions/26/05/19/260519-1341-unstuck-plugins/` contains the full research findings, spec, and decisions.

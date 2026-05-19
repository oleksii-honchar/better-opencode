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

When a loop is detected, the plugin performs **nudge-and-prune**: aborts the current stream, prunes the looping assistant messages from the conversation, injects a nudge user message telling the model to break the loop, and restarts the stream with the modified conversation.

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
│                    Nudge-and-Prune path                      │
│                                                             │
│  LoopDetectedError ──→ Abort current stream                 │
│                     └── Prune looping assistant msgs from   │
│                         args.messages (AI SDK format)       │
│                     └── Inject nudge user message:          │
│                         "You are stuck in a loop —          │
│                          break out and take a different     │
│                          direction."                        │
│                     └── Restart: call original doStream     │
│                         with modified messages              │
│                     └── If maxNudges exceeded → abort       │
└─────────────────────────────────────────────────────────────┘
```

### Component Design

#### 1. `UnstuckPlugin` — V2 Plugin Definition

```typescript
import { Effect } from "effect"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { LoopDetector } from "./loop-detector"
import { UnstuckConfig } from "./config"

export const UnstuckPlugin = PluginV2.define({
  id: PluginV2.ID.make("unstuck"),
  effect: Effect.gen(function* () {
    const config = yield* Effect.service(UnstuckConfig.Service)
    const detector = new LoopDetector(config)

    return {
      "aisdk.language": Effect.fn(function* (evt) {
        // Wrap the LanguageModelV3 to intercept every token
        const original = evt.language ?? evt.sdk.languageModel(evt.model.apiID)
        evt.language = wrapWithLoopDetection(original, detector, config)
      }),
    }
  }),
})
```

#### 2. `wrapWithLoopDetection` — LanguageModelV3 Wrapper

Wraps the original `LanguageModelV3` and intercepts `doStream` to observe every token. On loop detection, performs **nudge-and-prune**: aborts the stream, prunes looping messages, injects a nudge, and restarts.

```typescript
function wrapWithLoopDetection(model, detector, config) {
  let nudgeCount = 0  // Track nudges per conversation

  return {
    ...model,
    async *doStream(args) {
      try {
        const originalStream = model.doStream(args)
        for await (const chunk of originalStream) {
          // Intercept each chunk
          const loopInfo = detector.consumeChunk(chunk, config)
          if (loopInfo) {
            throw new LoopDetectedError(loopInfo)
          }
          yield chunk
        }
      } catch (error) {
        if (!(error instanceof LoopDetectedError)) throw error

        // --- Nudge-and-Prune ---
        if (config.strategy === "warn") {
          console.warn("[unstuck] Loop detected (warn mode):", error.info)
          throw error  // Don't attempt recovery
        }

        if (nudgeCount >= config.maxNudges) {
          console.error("[unstuck] Max nudges reached, aborting")
          throw error  // Fall back to abort
        }

        nudgeCount++

        // Prune looping assistant messages from args.messages
        const prunedMessages = pruneLoopingMessages(
          args.messages,
          error.info,
          config.pruneCount,
        )

        // Inject nudge user message
        const nudgedMessages = [
          ...prunedMessages,
          {
            role: "user",
            content: config.nudgeMessage ??
              "You appear to be stuck in a loop — repeating the same thinking or tool calls. " +
              "Break out of the pattern and take a different direction.",
            _unstuckNudge: true,  // Marker for debugging
          },
        ]

        // Reset detector state for the new attempt
        detector.reset()

        // Restart with modified messages
        const restartedStream = model.doStream({ ...args, messages: nudgedMessages })
        yield* restartedStream
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
    this.currentThinking = ""
    this.currentTools = []
    this.history = []
    this.inReasoning = false
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
  type: "step_loop" | "tool_loop"
  threshold: number
  fingerprint?: string
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
3. **Tool signature**: tool_name (lowercase) + sorted input keys (not values, since values may vary)

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

### Nudge-and-Prune Strategy

When a loop is detected, instead of simply aborting, the plugin attempts recovery:

1. **Abort** the current stream (throw `LoopDetectedError`)
2. **Prune** the last N looping assistant messages from `args.messages`
3. **Inject** a nudge user message: "You appear to be stuck in a loop — break out and take a different direction."
4. **Restart** the stream by calling the original `doStream` with modified messages
5. **Reset** the detector state so detection starts fresh
6. **Fallback**: If `maxNudges` (default: 2) is exceeded, fall back to abort

### Configuration Schema

```typescript
interface UnstuckConfig {
  enabled: boolean
  loopThreshold: number  // default: 3
  detectToolOnlyLoops: boolean  // default: true
  toolLoopThreshold: number  // default: 4
  historySize: number  // default: 10
  minThinkingLength: number  // default: 50
  includeReasoning: boolean  // default: true
  includeText: boolean  // default: true

  // Nudge-and-prune settings
  strategy: "nudge-and-prune" | "abort" | "warn"  // default: "nudge-and-prune"
  maxNudges: number  // default: 2
  pruneCount: number  // default: 3
  nudgeMessage?: string  // default: "You appear to be stuck in a loop..."
  logLevel: "debug" | "info" | "warn"  // default: "info"
}
```

### Configuration via opencode config

```json
{
  "plugins": {
    "unstuck": {
      "enabled": true,
      "loopThreshold": 3,
      "detectToolOnlyLoops": true,
      "toolLoopThreshold": 4,
      "historySize": 10,
      "minThinkingLength": 50,
      "strategy": "nudge-and-prune",
      "maxNudges": 2,
      "pruneCount": 3
    }
  }
}
```

### Error Handling and Edge Cases

1. **Stream already aborted**: Check `AbortSignal.aborted` before throwing
2. **Partial step at stream end**: Finalize current step with whatever was accumulated
3. **Empty thinking text**: Skip fingerprinting if text < `minThinkingLength`, only check tool signatures
4. **No tool calls in step**: Only check thinking fingerprint
5. **Mixed reasoning and text**: Concatenate reasoning first, then text
6. **Provider-executed tools**: Exclude from loop detection
7. **Compaction steps**: Exclude from loop detection
8. **False positive prevention**: `minThinkingLength` filter, higher threshold for tool-only loops, tool signature uses input keys not values

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

#### Phase 3: Nudge-and-Prune Integration
- [ ] Implement `pruneLoopingMessages` function
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
| **False positive abort** — legitimate response aborted | High | Higher thresholds for tool-only loops, `minThinkingLength` filter, configurable `strategy: "warn"` mode |
| **Performance overhead** — fingerprinting every chunk | Low | Fingerprinting only at step boundaries, not per-chunk; SHA-256 is fast for small strings |
| **Memory leak** — history ring buffer grows | Low | Ring buffer with configurable size, old entries evicted |
| **Breaks existing doom_loop** — conflicts with existing detection | Medium | Unstuck operates at a different level (step-level vs part-level); they complement each other |
| **Provider-specific behavior** — some providers don't emit finish-step | Medium | Handle partial steps; fall back to stream end as step boundary |
| **Nudge causes new loop** — model ignores nudge and loops again | Medium | `maxNudges` limit (default: 2) before falling back to abort |

### Key Decisions

1. **V2 `aisdk.language` hook over V1 `event` hook** — Full control over streaming, can intercept every token, can abort directly
2. **Multi-level detection** — Step-level, sentence-level, and tool-only modes cover different loop patterns
3. **Fingerprint-based comparison over exact matching** — Handles slight model output variations via normalization + SHA-256 hash
4. **Tool signature uses input keys, not values** — Handles input variations while still detecting same tool patterns
5. **Nudge-and-prune over abort-only** — Gives model a chance to recover instead of just stopping; configurable `maxNudges` prevents infinite recovery attempts
6. **Separate plugin over modifying existing `doom_loop`** — Different detection levels, complementary mechanisms, no risk of breaking existing behavior

---

**Related**: Session `260519-1341-unstuck-plugins` at `~/.agent-sessions/26/05/19/260519-1341-unstuck-plugins/` contains the full research findings, spec, and decisions.

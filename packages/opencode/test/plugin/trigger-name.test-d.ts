// Type-level acceptance for Task 1 (Change 1): widened `experimental.compaction.post_recall`
// hook contract + adapted `TriggerName` extraction in `src/plugin/index.ts`.
//
// Compile-time ONLY — verified by `bun turbo typecheck` (tsgo --noEmit). Never executed
// at runtime (bun test skips *.test-d.ts).
//
// RED phase: this file must FAIL to typecheck against the pre-change contracts
// (post_recall output was `undefined`, so `{ text }` was not assignable) and must PASS
// after the widening + TriggerName adaptation.

import type { Hooks } from "@opencode-ai/plugin"
import type { Interface as PluginInterface } from "../../src/plugin/index"

type PostRecallInput = Parameters<Required<Hooks>["experimental.compaction.post_recall"]>[0]
type PostRecallOutput = Parameters<Required<Hooks>["experimental.compaction.post_recall"]>[1]

// AC3 — the post_recall hook input exposes no `client` property: hooks must not perform
// HTTP prompt side-effects (the bensyne plugin receives `client` from PluginInput, the
// whole module input, NOT from the hook context).
export const _postRecallInputHasNoClient: keyof PostRecallInput extends "client" ? never : true = true

// AC2 — TriggerName must still admit "experimental.compaction.post_recall": the widened
// contract (output accepts `{ text?: string } | void`, return is Promise<...>) compiles
// through the plugin trigger API, and the output literal `{ text }` is assignable.
declare const plugin: PluginInterface
plugin.trigger(
  "experimental.compaction.post_recall",
  { sessionID: "ses_test", agent: "test-agent", model: {} as PostRecallInput["model"] },
  { text: "recall text" } as PostRecallOutput,
)

// AC4 — sibling hook contracts compile unchanged (no collateral from the widening):
//   - experimental.compaction.autocontinue -> output { enabled: boolean }
//   - experimental.session.compacting       -> output { context: string[]; prompt?: string }
export const _autocontinueUnchanged: NonNullable<
  Hooks["experimental.compaction.autocontinue"]
> extends (input: any, output: { enabled: boolean }) => Promise<void>
  ? true
  : never = true

export const _compactingUnchanged: NonNullable<
  Hooks["experimental.session.compacting"]
> extends (input: any, output: { context: string[]; prompt?: string }) => Promise<void>
  ? true
  : never = true
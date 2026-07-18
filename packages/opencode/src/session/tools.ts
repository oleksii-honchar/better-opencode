import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ModelID, ProviderID } from "@/provider/schema"
import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID, MessageID, SessionID } from "./schema"
import * as Log from "@opencode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"

const log = Log.create({ service: "session.tools" })

/** Type for tool.execute.after hook output with the inject field that plugins may add. */
type ToolExecuteAfterOutput = {
  title: string
  output: string
  metadata: any
  inject?: Array<{ role: "user" | "system"; text: string }>
}

/**
 * Flush synthetic user messages injected by tool.execute.after hooks.
 * Persists messages via sessions API so they survive compaction.
 * System-role injections are wrapped in <system-reminder> tags.
 */
const flushInjectedMessages = Effect.fn("SessionTools.flushInjectedMessages")(function* (input: {
  injected: Array<{ role: "user" | "system"; text: string }>
  sessionID: SessionID
  agent: string
  providerID: ProviderID
  modelID: ModelID
}) {
  if (input.injected.length === 0) return

  const sessions = yield* Session.Service

  for (const injection of input.injected) {
    const isSystem = injection.role === "system"
    const wrapped = isSystem
      ? `<system-reminder>${injection.text}</system-reminder>`
      : injection.text

    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.agent,
      model: { providerID: input.providerID, modelID: input.modelID },
    }
    yield* sessions.updateMessage(userMsg)

    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      type: "text",
      text: wrapped,
      synthetic: true,
    } satisfies MessageV2.TextPart)
  }
})

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx)
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            const hookOutput = yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            const hookOutputWithInject = hookOutput as ToolExecuteAfterOutput
            if (hookOutputWithInject.inject && hookOutputWithInject.inject.length > 0) {
              yield* flushInjectedMessages({
                injected: hookOutputWithInject.inject,
                sessionID: ctx.sessionID,
                agent: input.agent.name,
                providerID: input.model.providerID,
                modelID: ModelID.make(input.model.api.id),
              })
            }
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
    ;(tools[item.id] as any).server = "built-in"
  }

  for (const [key, item] of Object.entries(yield* mcp.tools(input.agent))) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, schema)
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const start = Date.now()
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
            Effect.tapDefect((e) =>
              Effect.sync(() => {
                const msg = e instanceof Error ? e.message : String(e)
                Log.toolsLog({
                  tool: key,
                  sessionId: ctx.sessionID,
                  messageId: input.processor.message.id,
                  callId: opts.toolCallId,
                  durationMs: Date.now() - start,
                  args,
                  error: msg,
                  source: "mcp",
                })
              }),
            ),
          )
          const hookOutput = yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )
          const hookOutputWithInject = hookOutput as ToolExecuteAfterOutput
          if (hookOutputWithInject.inject && hookOutputWithInject.inject.length > 0) {
            yield* flushInjectedMessages({
              injected: hookOutputWithInject.inject,
              sessionID: ctx.sessionID,
              agent: input.agent.name,
              providerID: input.model.providerID,
              modelID: ModelID.make(input.model.api.id),
            })
          }

          const textParts: string[] = []
          const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)

          Log.toolsLog({
            tool: key,
            sessionId: ctx.sessionID,
            messageId: input.processor.message.id,
            callId: opts.toolCallId,
            durationMs: Date.now() - start,
            args,
            output: truncated.content,
            truncated: truncated.truncated,
            ...(truncated.truncated ? { rawOutputLength: textParts.join("\n\n").length } : {}),
            ...(result.structuredContent !== undefined && {
              structuredContent: (() => {
                const s = JSON.stringify(result.structuredContent);
                return s.length > 500 ? s.slice(0, 500) + '...' : s;
              })(),
              scLength: JSON.stringify(result.structuredContent).length,
            }),
            source: "mcp",
          })

          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
            ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }),
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  return tools
})

export * as SessionTools from "./tools"

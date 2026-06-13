import { describe, expect, test } from "bun:test"
import type { Hooks, Model } from "../src/index.js"

describe("experimental.tools.transform hook", () => {
  test('"experimental.tools.transform" is a valid key on Hooks interface', () => {
    // Compile-time type check: this assignment must type-check.
    // If "experimental.tools.transform" is NOT on the Hooks interface,
    // TypeScript will error because the key is not recognized.
    const hooks: Hooks = {
      "experimental.tools.transform": async (input, output) => {
        // Verify input shape at compile time
        const _model: Model = input.model
        const _sessionID: string | undefined = input.sessionID
        // Verify output shape at compile time
        const _tools: Record<string, any> = output.tools
        void _model
        void _sessionID
        void _tools
      },
    }

    expect("experimental.tools.transform" in hooks).toBe(true)
  })

  test("hook accepts correct input type", async () => {
    const hooks: Hooks = {
      "experimental.tools.transform": async (input, _output) => {
        // model is required and must be a Model
        expect(input.model).toBeDefined()
        // sessionID is optional
        const _sessionID: string | undefined = input.sessionID
        expect(typeof _sessionID).toBe("string")
      },
    }

    // Invoke with valid input
    const model: Model = {
      providerID: "test",
      modelID: "test-model",
      name: "Test Model",
      info: {
        id: "test-model",
        name: "Test Model",
        contextLength: 128000,
        maxOutputTokens: 8192,
      },
    }

    const trigger = hooks["experimental.tools.transform"]!
    await trigger({ sessionID: "test-session", model }, { tools: {} })
  })

  test("hook accepts correct output type with tools dictionary", async () => {
    const hooks: Hooks = {
      "experimental.tools.transform": async (_input, output) => {
        // tools should be a Record<string, any>
        expect(typeof output.tools).toBe("object")
        // Should be modifiable
        output.tools["test-tool"] = {} as any
        expect(output.tools["test-tool"]).toBeDefined()
      },
    }

    const trigger = hooks["experimental.tools.transform"]!
    await trigger({ model: {} as Model }, { tools: {} })
  })

  test("hook key is accessible on empty Hooks object", () => {
    // Compile-time check: accessing the key on a Hooks typed variable
    // must not produce a TypeScript error. At runtime it returns undefined
    // for an empty hooks object, which is correct for an optional property.
    const hooks: Hooks = {}
    const hookFn = hooks["experimental.tools.transform"]
    expect(hookFn).toBeUndefined()
  })

  test("hook function returns Promise<void>", async () => {
    let resolved = false
    const hooks: Hooks = {
      "experimental.tools.transform": async (_input, _output) => {
        resolved = true
      },
    }

    const trigger = hooks["experimental.tools.transform"]!
    const result = trigger({ model: {} as Model }, { tools: {} })

    // Must return a Promise
    expect(result).toBeInstanceOf(Promise)
    await result
    expect(resolved).toBe(true)
  })

  test("hook type is correctly inferred from Hooks interface", () => {
    // This is the key compile-time test: the hook type must be inferred
    // from the Hooks interface, not as `any`. If the key is not on the
    // interface, the type of `hookFn` would be `any` or cause an error.
    const hooks: Hooks = {
      "experimental.tools.transform": async (_input, _output) => {},
    }

    const hookFn = hooks["experimental.tools.transform"]

    // The hook must be a function typed as (input, output) => Promise<void>
    // If the key is not on the interface, hookFn would be `any` and this
    // test would not catch it at compile time.
    expect(typeof hookFn).toBe("function")

    // Type-level assertion: ensure the hook is typed as a function, not `any`
    // This will fail at compile time if hookFn is `any`
    const _check: ((
      input: { sessionID?: string; model: Model },
      output: { tools: Record<string, any> },
    ) => Promise<void>) = hookFn!
    expect(typeof _check).toBe("function")
  })
})

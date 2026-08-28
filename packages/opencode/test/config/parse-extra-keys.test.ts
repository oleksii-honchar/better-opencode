import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigParse } from "../../src/config/parse"

// Focused regression test for the ConfigParse.schema Decoder<unknown, never>
// bound (Task 3) — exercises topLevelExtraKeys with a standalone schema so it
// is independent of the Config.Info import graph (which currently crashes at
// module load on lsp/client.ts until Task 8 lands).

const Info = Schema.Struct({
  shell: Schema.String,
})

test("config parser rejects unknown top-level keys", () => {
  try {
    ConfigParse.schema(Info, { shell: "/bin/zsh", invalid_field: true }, "test")
    throw new Error("expected config parse to fail")
  } catch (err) {
    const error = err as { data?: { issues?: Array<{ code?: string; keys?: string[]; path?: string[] }> } }
    expect(error.data?.issues?.[0]).toMatchObject({ code: "unrecognized_keys", keys: ["invalid_field"], path: [] })
  }
})

test("config parser preserves known keys while rejecting extra top-level keys", () => {
  const config = ConfigParse.schema(Info, { shell: "/bin/bash" }, "test")
  expect(config).toEqual({ shell: "/bin/bash" })
})
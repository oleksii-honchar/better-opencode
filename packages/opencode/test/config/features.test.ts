import { test, expect } from "bun:test"
import { Config } from "@/config/config"
import { ConfigParse } from "../../src/config/parse"

test("features.mcpFilePathBase64Encode parses enable flag", () => {
  const config = ConfigParse.schema(Config.Info, {
    features: {
      mcpFilePathBase64Encode: {
        enable: true,
        includeMCP: ["hugging-kreuzberg"],
      },
    },
  }, "test")

  expect(config.features?.mcpFilePathBase64Encode?.enable).toBe(true)
  expect(config.features?.mcpFilePathBase64Encode?.includeMCP).toEqual(["hugging-kreuzberg"])
})

test("features.mcpFilePathBase64Encode with enable false", () => {
  const config = ConfigParse.schema(Config.Info, {
    features: {
      mcpFilePathBase64Encode: {
        enable: false,
      },
    },
  }, "test")

  expect(config.features?.mcpFilePathBase64Encode?.enable).toBe(false)
  expect(config.features?.mcpFilePathBase64Encode?.includeMCP).toBeUndefined()
})

test("features.mcpFilePathBase64Encode with empty includeMCP", () => {
  const config = ConfigParse.schema(Config.Info, {
    features: {
      mcpFilePathBase64Encode: {
        enable: true,
        includeMCP: [],
      },
    },
  }, "test")

  expect(config.features?.mcpFilePathBase64Encode?.enable).toBe(true)
  expect(config.features?.mcpFilePathBase64Encode?.includeMCP).toEqual([])
})

test("features is optional and missing should not error", () => {
  const config = ConfigParse.schema(Config.Info, {
    model: "test/model",
  }, "test")

  expect(config.features).toBeUndefined()
  expect(config.model).toBe("test/model")
})

test("features.mcpFilePathBase64Encode is optional and missing should not error", () => {
  const config = ConfigParse.schema(Config.Info, {
    features: {},
  }, "test")

  expect(config.features?.mcpFilePathBase64Encode).toBeUndefined()
})

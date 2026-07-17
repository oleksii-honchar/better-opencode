import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  JsonSchemaValidatorResult,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js"
import * as Log from "@opencode-ai/core/util/log"

const TOLERATED_ERROR_RE = /additional properties|excess property/i

const log = Log.create({ service: "mcp.lenient-validator" })

export class LenientJsonSchemaValidator implements jsonSchemaValidator {
  #delegate: AjvJsonSchemaValidator
  #warned = new Set<string>()

  constructor(delegate?: AjvJsonSchemaValidator) {
    this.#delegate = delegate ?? new AjvJsonSchemaValidator()
  }

  /** @internal — exposed for testing only */
  get warned(): Set<string> {
    return this.#warned
  }

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const inner = this.#delegate.getValidator<T>(schema)

    return (input: unknown): JsonSchemaValidatorResult<T> => {
      const result = inner(input)

      if (result.valid) {
        return result
      }

      if (!TOLERATED_ERROR_RE.test(result.errorMessage)) {
        return result
      }

      const key = dedupKey(schema, result.errorMessage)

      if (!this.#warned.has(key)) {
        this.#warned.add(key)
        log.warn("tolerated additionalProperties validation error (toJsonSchemaCompat false positive)", {
          key,
          error: result.errorMessage,
        })
      }

      return { valid: true, data: input as T, errorMessage: undefined }
    }
  }
}

function dedupKey(schema: JsonSchemaType, errorMessage: string): string {
  const id = schema.$id ?? "unknown"
  const prefix = errorMessage.slice(0, 50)
  return `${id}-${prefix}`
}

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  JsonSchemaValidatorResult,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "mcp.lenient-validator" })

/**
 * Regex that matches AJV's additionalProperties / excess property errors.
 * These are false positives caused by toJsonSchemaCompat() conversion bugs
 * and should be tolerated (log warning, return valid).
 */
const ADDITIONAL_PROPERTIES_RE = /additional properties|excess property/i

export class LenientJsonSchemaValidator implements jsonSchemaValidator {
  private readonly delegate: AjvJsonSchemaValidator
  private readonly warned = new Set<string>()

  constructor(delegate?: AjvJsonSchemaValidator) {
    this.delegate = delegate ?? new AjvJsonSchemaValidator()
  }

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const delegateValidator = this.delegate.getValidator<T>(schema)

    return (input: unknown): JsonSchemaValidatorResult<T> => {
      const result = delegateValidator(input)

      if (result.valid) {
        return result
      }

      // Check if this is an additionalProperties / excess property error
      if (ADDITIONAL_PROPERTIES_RE.test(result.errorMessage)) {
        // Deduplicate warnings: log once per unique schema+error combo
        const errorKey = `${schema.$id ?? "unknown"}-${result.errorMessage.substring(0, 50)}`
        if (!this.warned.has(errorKey)) {
          this.warned.add(errorKey)
          log.warn("additionalProperties error tolerated (toJsonSchemaCompat false positive)", {
            errorKey,
            errorMessage: result.errorMessage,
          })
        }
        return { valid: true, data: input as T, errorMessage: undefined }
      }

      // Type mismatch, required field, etc. — pass through as failure
      return result
    }
  }
}

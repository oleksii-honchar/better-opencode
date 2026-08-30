/**
 * Prefix-tolerant MCP tool-name matcher.
 *
 * For each config entry `P` and server-returned tool name `T`,
 * `toolNameMatches(T, [P])` is true iff `T === P` (exact, backward
 * compatible) OR `T` equals `P` preceded by any non-empty prefix
 * terminated by one of the separators `-`, `_`, `.`.
 *
 * Compiled per-entry regex (cached):
 *   ^(?:.*[._-])?P_escaped$
 * where `P_escaped` is `P` with regex metacharacters escaped. The optional
 * group covers the exact case, so one predicate handles both.
 */

const regexCache = new Map<string, RegExp>()

/** Escape regex metacharacters so an entry cannot inject regex. */
function escapeRegExp(entry: string): string {
  return entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function compiledRegex(entry: string): RegExp {
  let regex = regexCache.get(entry)
  if (!regex) {
    regex = new RegExp(`^(?:.*[._-])?${escapeRegExp(entry)}$`)
    regexCache.set(entry, regex)
  }
  return regex
}

/**
 * Returns true if `toolName` equals any entry in `names` exactly, or equals
 * an entry preceded by any non-empty prefix terminated by `-`, `_`, or `.`.
 */
export function toolNameMatches(toolName: string, names: readonly string[]): boolean {
  if (toolName.length === 0 || names.length === 0) {
    return false
  }
  return names.some((entry) => compiledRegex(entry).test(toolName))
}
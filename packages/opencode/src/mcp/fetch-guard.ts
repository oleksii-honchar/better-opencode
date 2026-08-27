/**
 * Wraps the global `fetch` to guard the MCP SDK's unguarded `response.json()`
 * calls against empty/non-JSON 2xx bodies (the JSC `JSON Parse error:
 * Unrecognized token ''` crash class). Order matters:
 *
 * 1. `!res.ok` (incl. 401), `202`, `204`, and `text/event-stream` → pass
 *    through untouched. 401 is the OAuth trigger — the SDK reads
 *    `www-authenticate`, never the body. 202 (notification accepted) is
 *    always empty-bodied and the SDK skips body processing for it. SSE is
 *    a long-lived stream that must never be read.
 * 2. `content-length: 0` on a 2xx response → throw an empty-body error.
 * 3. `application/json` on a 2xx response → validate via `res.clone()`;
 *    empty/whitespace or non-JSON bodies become descriptive errors. Valid JSON
 *    returns the original response unchanged (clone consumed).
 * 4. Any other 2xx content type → pass through untouched (no unbounded reads).
 */
export function guardedFetchFn(serverUrl: string | URL): typeof fetch {
  const resolved = typeof serverUrl === "string" ? serverUrl : serverUrl.href
  const guarded = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const res = await fetch(input, init)

    if (!res.ok || res.status === 202 || res.status === 204) {
      return res
    }

    const contentType = res.headers.get("content-type")?.toLowerCase() ?? ""

    if (contentType.startsWith("text/event-stream")) {
      return res
    }

    if (res.headers.get("content-length") === "0") {
      throw new Error(
        `MCP server ${resolved} returned an empty response body (HTTP ${res.status}). ` +
          "Refusing to parse it as JSON — an empty body would crash with a JSC parse error.",
      )
    }

    if (contentType.startsWith("application/json")) {
      const clone = res.clone()
      const text = await clone.text()
      if (text.trim() === "") {
        throw new Error(
          `MCP server ${resolved} returned a non-JSON response body (HTTP ${res.status}): ` +
            "the body is empty.",
        )
      }
      try {
        JSON.parse(text)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(
          `MCP server ${resolved} returned a non-JSON response body (HTTP ${res.status}): ${msg}`,
        )
      }
      return res
    }

    return res
  }
  // Bun's `typeof fetch` carries a `preconnect` static that is irrelevant to the
  // wrapper contract; the SDK consumes the plain callable via its `FetchLike` type.
  return guarded as typeof fetch
}

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { guardedFetchFn } from "./fetch-guard"

const SERVER_URL = "https://example.com/mcp"

describe("guardedFetchFn", () => {
  const originalFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof mock>

  beforeEach(() => {
    fetchMock = mock(async () => new Response("{}", { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  async function runGuard(response: Response): Promise<Response> {
    fetchMock.mockImplementation(async () => response)
    const guarded = guardedFetchFn(SERVER_URL)
    return guarded("https://example.com/mcp")
  }

  test("passes a valid JSON 2xx response through with the original body still readable", async () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'
    const res = new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })

    const out = await runGuard(res)

    expect(out).toBe(res)
    expect(out.bodyUsed).toBe(false)
    expect(await out.text()).toBe(body)
  })

  test("accepts a JSON content type with a charset parameter", async () => {
    const body = '{"result":"ok"}'
    const res = new Response(body, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    })

    const out = await runGuard(res)

    expect(out).toBe(res)
    expect(await out.text()).toBe(body)
  })

  test("throws for a 2xx response with content-length: 0, naming the server URL and status", async () => {
    const res = new Response("", {
      status: 200,
      headers: { "content-length": "0" },
    })

    await expect(runGuard(res)).rejects.toThrow(SERVER_URL)
    await expect(runGuard(res)).rejects.toThrow("200")
  })

  test("throws for a 2xx application/json response with an empty/whitespace body, naming URL and status", async () => {
    const res = new Response("   ", {
      status: 200,
      headers: { "content-type": "application/json" },
    })

    await expect(runGuard(res)).rejects.toThrow(SERVER_URL)
    await expect(runGuard(res)).rejects.toThrow("200")
  })

  test("throws for a 2xx application/json response with a non-JSON body (HTML), naming URL and status", async () => {
    const res = new Response("<html><body>oops</body></html>", {
      status: 200,
      headers: { "content-type": "application/json" },
    })

    await expect(runGuard(res)).rejects.toThrow(SERVER_URL)
    await expect(runGuard(res)).rejects.toThrow("200")
  })

  test("passes a 401 empty-body response through untouched (body not read)", async () => {
    const res = new Response("", {
      status: 401,
      headers: { "content-length": "0", "www-authenticate": 'Basic realm="mcp"' },
    })

    const out = await runGuard(res)

    expect(out).toBe(res)
    expect(out.bodyUsed).toBe(false)
  })

  test("passes a text/event-stream 2xx response through untouched (body never read)", async () => {
    const res = new Response('event: message\ndata: {"x":1}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })

    const out = await runGuard(res)

    expect(out).toBe(res)
    expect(out.bodyUsed).toBe(false)
  })

  test("passes a 204 response through untouched", async () => {
    const res = new Response(null, { status: 204 })

    const out = await runGuard(res)

    expect(out).toBe(res)
    expect(out.bodyUsed).toBe(false)
  })

  test("passes a 202 notification-accepted empty-body response through untouched", async () => {
    // MCP StreamableHTTP: POST notifications/* (e.g. notifications/initialized)
    // are answered with 202 + content-length: 0. The SDK never reads its body.
    // Regression: throwing here broke every remote MCP connect (TUI showed
    // "connecting..." then disabled) — see findings 260827-0903-oauth-auto-open-limit.
    const res = new Response(null, {
      status: 202,
      headers: { "content-type": "application/json", "content-length": "0" },
    })

    const out = await runGuard(res)

    expect(out).toBe(res)
    expect(out.bodyUsed).toBe(false)
  })

  test("passes a non-JSON 2xx content type (text/plain) through untouched", async () => {
    const res = new Response("plain text body", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })

    const out = await runGuard(res)

    expect(out).toBe(res)
    expect(out.bodyUsed).toBe(false)
    expect(await out.text()).toBe("plain text body")
  })
})

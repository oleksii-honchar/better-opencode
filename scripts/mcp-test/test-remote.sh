#!/usr/bin/env bash
# test-remote.sh — Quick smoke test for a remote MCP server via HTTP JSON-RPC
#
# Usage:
#   test-remote.sh <url> [method] [params_json]
#
# Examples:
#   test-remote.sh http://localhost:3000/mcp
#   test-remote.sh http://localhost:3000/mcp tools/list
#   test-remote.sh http://localhost:3000/mcp tools/call '{"name":"search","arguments":{"q":"test"}}'
#
# The server uses SSE (Server-Sent Events) format. This script parses
# the SSE response and extracts the JSON data.

set -euo pipefail

URL="${1:?Usage: test-remote.sh <url> [method] [params_json]}"
METHOD="${2:-tools/list}"
PARAMS="${3:-{}}"

# Build JSON-RPC payload
PAYLOAD=$(jq -n \
  --argjson id 1 \
  --arg method "$METHOD" \
  --argjson params "$PARAMS" \
  '{jsonrpc: "2.0", id: $id, method: $method, params: $params}')

echo "POST $URL"
echo "Method: $METHOD"
echo "Payload: $PAYLOAD"
echo "---"

# Send request with proper Accept header for MCP Streamable HTTP
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$PAYLOAD" \
  "$URL")

# Extract HTTP status code (last line)
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_CODE"
echo "---"

if [[ "$HTTP_CODE" -ne 200 ]]; then
  echo "Response body:"
  echo "$BODY"
  exit 1
fi

# Parse SSE: extract "data: " lines and parse JSON
# The MCP SDK returns SSE format: event: message\ndata: {json}
# Use grep+sed for portability (bash regex capture groups are unreliable in zsh)
JSON_DATA=$(echo "$BODY" | grep '^data: ' | head -1 | sed 's/^data: //')

if [[ -z "$JSON_DATA" ]]; then
  # Maybe the response is plain JSON (not SSE)
  JSON_DATA="$BODY"
fi

# Pretty-print the JSON
if [[ -n "$JSON_DATA" ]]; then
  echo "$JSON_DATA" | jq . 2>/dev/null || echo "$JSON_DATA"
else
  echo "No JSON data found in response"
  echo "Raw response:"
  echo "$BODY"
  exit 1
fi

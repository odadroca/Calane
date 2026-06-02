# Scenario 03 — Drive a pipeline via REST, MCP, and A2A

**Goal:** run the *same* pipeline through each network surface, so you can wire
the kernel into a REST client, an MCP client (e.g. Claude), or an A2A agent
caller.

**Surfaces:** [REST](../rest-reference.md), [MCP](../mcp.md), A2A
([a2a.md](../a2a.md)). **Provider:** mock.

All three surfaces back the same 8-tool surface; `run_pipeline` is the entry
point everywhere.

## REST

Start the server, then drive it with `curl`:

```bash
PORT=8787 node packages/server/dist/server.js &

# run_pipeline
curl -s -X POST localhost:8787/runs -H 'content-type: application/json' -d '{
  "pipelineId": "swot_recursive",
  "input": "Evaluate releasing the kernel as open source.",
  "options": { "providers": ["mock"], "depth": 1 }
}'   # -> 201, the RunResult (note runId)

# get_run_result + export_run_bundle
curl -s localhost:8787/runs/<runId>
curl -s "localhost:8787/runs/<runId>/export?outDir=run_bundles"
```

When a token is configured (`CALANE_API_TOKEN`), add
`-H "authorization: Bearer <token>"`. See [auth.md](../auth.md).

## MCP

Local clients speak MCP over stdio. A minimal `tools/call` for `run_pipeline`:

```bash
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_pipeline","arguments":{"pipelineId":"swot_recursive","input":"topic","options":{"providers":["mock"]}}}}' \
 | node packages/mcp-server/dist/server.js
```

To register it with a client (Claude Desktop, etc.), see the config block in
[mcp.md](../mcp.md). For the remote Streamable HTTP transport, see
[remote-mcp.md](../remote-mcp.md).

## A2A

Each pipeline is exposed as a synchronous A2A agent. Discover it, then invoke via
JSON-RPC `message/send` (maps to exactly one `run_pipeline`):

```bash
curl -s localhost:8787/.well-known/agent-card/swot_recursive

curl -s -X POST localhost:8787/a2a/swot_recursive \
  -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": "req-1", "method": "message/send",
  "params": { "message": { "role": "ROLE_USER", "messageId": "m1",
    "parts": [{ "text": "Evaluate releasing the kernel as open source." }] } }
}'
```

The response is a JSON-RPC result wrapping a single COMPLETED A2A Task carrying
the run's synthesis as an artifact. Discovery cards are public; invocation is
auth-gated when a token is configured. See [a2a.md](../a2a.md).

---

**Verified by:** REST — `packages/server/tests/scenario-rest.test.ts`; MCP —
`packages/mcp-server/tests/scenario-mcp.test.ts` and
`packages/mcp-server/tests/surface.test.ts`; A2A —
`packages/server/tests/a2a.test.ts`.

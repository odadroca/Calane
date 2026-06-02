# MCP support

MCP support is **mandatory** and **implemented** (not stubbed). The server uses
the official `@modelcontextprotocol/sdk` and speaks MCP over stdio.

## The compact tool surface (8 tools)

To respect the OpenAI/MCP tool surface limit of ~30 tools, we expose a small set
of **coarse-grained** tools — never one tool per internal class, plugin, or
channel. Exactly these 8:

| Tool | Description |
| --- | --- |
| `run_pipeline` | Execute a named pipeline against an input and store the run. |
| `get_run_result` | Fetch a stored run result by id. |
| `list_pipelines` | List available pipeline ids. |
| `validate_pipeline` | Validate a pipeline definition by id. |
| `export_run_bundle` | Export a reproducible run bundle for a stored run. |
| `rerun_channel` | Re-run a single channel using an existing run's input. |
| `list_runs` | List stored run ids. |
| `get_pipeline_spec` | Fetch the resolved spec + source metadata for a pipeline. |

The definitions live in `packages/mcp-server/src/tools.ts` and are asserted to
be exactly 8 (and ≤ 30) by `packages/mcp-server/tests/surface.test.ts`.

Operations that are *not* their own tool (resume, diff, stats, federation, A2A)
fold into this surface — e.g. resuming a partial run is `run_pipeline` with
`options.resumeFromRunId`, not a ninth tool. The same 8 tools back the
[REST surface](./rest-reference.md) and [`openai.json`](./openai-json.md).

## Tool details

Every tool returns its result as a single `text` content block containing
pretty-printed JSON. On failure a tool returns `isError: true` with the error
message as text (e.g. `run not found: <id>`).

### `run_pipeline`

Execute a named pipeline against an input and store the run. To resume a prior
partial run, set `options.resumeFromRunId` — completed channels are carried
forward and `pipelineId`/`input` are taken from the prior run.

- **Input**: `pipelineId` (string, required), `input` (string, required),
  `options?` `{ providers?: string[], depth?: number, maxConcurrency?: number, timeoutMs?: number, resumeFromRunId?: string }`.
- **Output**: the full `RunResult`.

```json
{ "name": "run_pipeline",
  "arguments": { "pipelineId": "swot_recursive", "input": "...",
                 "options": { "providers": ["mock"], "depth": 1 } } }
```

### `get_run_result`

Fetch a stored run by id. **Input**: `runId` (required). **Output**: the
`RunResult`. Errors if the id is unknown.

### `list_pipelines`

List available pipeline ids. **Input**: none. **Output**: `{ pipelines: string[] }`.

### `validate_pipeline`

Validate a stored pipeline definition by id. **Input**: `pipelineId` (required).
**Output**: `{ valid, pipelineId, issues[], pipelineHash }`. See
[pipeline-validate.md](./pipeline-validate.md).

### `export_run_bundle`

Export a reproducible bundle for a stored run. **Input**: `runId` (required),
`outDir?` (default `run_bundles`), `redacted?` (boolean). **Output**: the
exporter result (`{ bundlePath, … }`). See [run-bundle.md](./run-bundle.md).

### `rerun_channel`

Re-run a single channel using an existing run's input (re-executes the pipeline
from that input and returns the one requested channel). **Input**: `runId` and
`channelId` (both required). **Output**: `{ runId, channel }`. Errors if the run
or channel is not found.

### `list_runs`

List stored run ids. **Input**: none. **Output**: `{ runs: string[] }`.

### `get_pipeline_spec`

Fetch the resolved spec and source metadata for a pipeline. **Input**:
`pipelineId` (required). **Output**: the `ResolvedPipeline` (spec + source
metadata + `pipelineHash`).

## Schema rule compliance

The server uses the **low-level** SDK `Server` so that tool `inputSchema`s are
plain **JSON Schema** objects. No Zod is authored anywhere (per the project
schema rule). Tool inputs are validated by the kernel's Ajv-based validator and
by the handlers themselves.

## Running

```bash
node packages/mcp-server/dist/server.js
```

Register it with any MCP client (e.g. Claude Desktop) as a stdio server:

```json
{
  "mcpServers": {
    "llm-pipeline-kernel": {
      "command": "node",
      "args": ["/abs/path/packages/mcp-server/dist/server.js"],
      "env": {
        "LLM_PIPE_REGISTRY": "/abs/path/examples",
        "LLM_PIPE_STORE": "/abs/path/.runs"
      }
    }
  }
}
```

## HTTP transport (remote connectors)

The same 8 tools are also served over the **Streamable HTTP** transport for
remote Claude connectors (Phase 7 / R1):

```bash
CALANE_MCP_HTTP=1 PORT=8788 node packages/mcp-server/dist/server.js
# or: node packages/mcp-server/dist/server.js --http --port 8788
```

The HTTP endpoint is mounted at `/mcp`. See [remote-mcp.md](./remote-mcp.md) and
[deploy-render.md](./deploy-render.md).

## Authentication

When a token is configured (`CALANE_API_TOKEN` or `~/.calane/auth.toml`), every
**tool call** must carry a matching token in the request auth metadata (the
transport `authInfo.token`, or `params._meta.token`). When OIDC is configured, a
valid OAuth 2.1 access token is also accepted (dual auth). `tools/list` is always
unauthenticated (tool discovery). When neither a token nor OIDC is configured,
auth is disabled (local use). See [auth.md](./auth.md).

## Quick stdio check

```bash
printf '%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
 | node packages/mcp-server/dist/server.js
```

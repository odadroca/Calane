# openai.json support

`openai.json` support is **mandatory** and **implemented** (not stubbed). The
manifest lives at `packages/server/public/openai.json` and is served by the REST
server at `GET /openai.json`.

## Purpose

It describes the **same compact 8-tool surface** as MCP, in an OpenAI-style
function/tool manifest, so an OpenAI-compatible tool caller can drive the kernel.
Because of the ~30-tool action limit, functionality is grouped behind 8
coarse-grained tools — not one tool per plugin or channel.

## Tools → REST endpoints

Each tool carries an `x-endpoint` mapping to the REST API it calls:

| Tool | Method | Path |
| --- | --- | --- |
| `run_pipeline` | POST | `/runs` |
| `get_run_result` | GET | `/runs/{runId}` |
| `list_pipelines` | GET | `/pipelines` |
| `validate_pipeline` | POST | `/pipelines/{pipelineId}/validate` |
| `export_run_bundle` | GET | `/runs/{runId}/export` |
| `rerun_channel` | POST | `/runs/{runId}/rerun-channel` |
| `list_runs` | GET | `/runs` |
| `get_pipeline_spec` | GET | `/pipelines/{pipelineId}` |

The openai.json layer is intended to **call the REST API** (set `api.base_url`
to your server). A summary OpenAPI description is exported from
`packages/server/src/openapi.ts`.

## REST endpoints

```
POST /runs
GET  /runs
GET  /runs/:runId
GET  /pipelines
GET  /pipelines/:pipelineId
POST /pipelines/:pipelineId/validate
POST /runs/:runId/rerun-channel
GET  /runs/:runId/export
```

## Example

```bash
PORT=8787 node packages/server/dist/server.js &
curl -s localhost:8787/openai.json | jq '.tools[].function.name'
curl -s -X POST localhost:8787/runs -H 'content-type: application/json' \
  -d '{"pipelineId":"swot_recursive","input":"...","options":{"providers":["mock"],"depth":1}}'
```

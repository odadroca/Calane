<p align="center"><img src="https://i.postimg.cc/CK3Y2j2f/calane.jpg" alt="calane" width="800" height="200"></p>

# llm-pipeline-kernel 

A small, **inspectable execution kernel for recurring analytical LLM workflows**.

It runs **versioned, schema-validated, multi-model analysis pipelines** and
exports **traceable run bundles**. The core defensible artifact is *a traceable,
versioned, schema-validated reasoning run*.

This is a **kernel**, not a platform. See the non-goals below.

## What it is

A caller — a human, an LLM, an agent, an MCP client, a REST client, or an
OpenAI-style tool caller — can:

1. execute a named pipeline,
2. resolve its prompts/specs (filesystem or Git registry),
3. run channels across providers or delegated agents,
4. validate structured outputs against JSON Schema,
5. store the run (metadata, raw + parsed outputs, validation reports),
6. emit telemetry (pluggable; no-op by default),
7. synthesize results (synthesis is just another channel),
8. optionally recurse (bounded, explicit — never model-decided), and
9. export the full, reproducible run bundle.

## Non-goals (binding)

- No visual builder.
- No hosted SaaS.
- No authentication UI.
- No billing.
- No marketplace.
- No general-purpose agent framework.
- No LangGraph clone.
- No Langfuse clone.
- No prompt-management product.
- No enterprise policy engine.

Plus, for the first implementation: no UI, no multi-tenant SaaS, no enterprise auth.

## What's added in this

Each item maps to a single commit visible in this repo's `git log` after the
`Initial snapshot from upstream …` commit.

1. **`core` — fail-fast on permanent provider errors.** The retry classifier
   buckets every non-timeout failure as `provider_error`, so the configured
   `retry.on` filter could not distinguish a missing API key (permanent) from a
   429 (transient). `ChannelExecutor` now treats missing-credentials and 4xx
   auth / bad-request errors as non-retryable while 429, 5xx, and timeouts stay
   retryable. Added unit tests in `packages/core/tests/retry-repair.test.ts`.
2. **`examples` — multi-model distillation pipelines.**
   `examples/pipelines/distillation.pipeline.yaml` distils a subject across
   Claude / GPT / Mistral / Gemini in parallel, then synthesises on Anthropic
   with bounded depth-2 recursion (`synthesis_only` carry-forward).
   `examples/pipelines/distillation_2key.pipeline.yaml` is a trimmed variant
   that completes end-to-end with only `MISTRAL_API_KEY` + `GEMINI_API_KEY`
   (synthesis on Mistral, free-tier Gemini model). Shared prompts under
   `examples/prompts/distillation/`, schemas under
   `examples/schemas/distillation.*.schema.json`.
3. **`docker` — multi-stage Dockerfile + `.dockerignore`** for the combined
   entrypoint. Mirrors `render.yaml` byte-for-byte (same port, same env
   defaults, same volume, same boot model) so the two deployment paths share
   one boot story. See [`docs/deploy-docker.md`](./docs/deploy-docker.md).
4. **`fix` — Node-22 engine bump.** `package.json` `engines.node` and
   `render.yaml` `NODE_VERSION` were `>=20`/`"20"`; the pinned `pnpm@11.3.0`
   needs Node ≥22.13 (it imports `node:sqlite`, a Node-22 built-in). A
   from-scratch `pnpm install` on Node 20 failed immediately; both are now
   `>=22`/`"22"`. Discovered while running the first independent `docker
   build` of the upstream tree.

## Architecture

```
Caller
  -> Gateway (CLI | REST | MCP | openai.json)
  -> PipelineExecutor
  -> PromptRegistryPlugin           (filesystem | git)
  -> ExecutionPlan                  (explicit channels, providers, depth, synthesis)
  -> ChannelExecutor                (direct_provider | delegated_agent)
  -> ProviderAdapter / DelegatedAgent
  -> JsonSchemaValidator (Ajv)
  -> ResultStorePlugin              (filesystem)
  -> TelemetrySink                  (no-op by default)
  -> RunBundleExporter
```

See [`docs/architecture.md`](./docs/architecture.md) for detail, and
[`docs/plugin-model.md`](./docs/plugin-model.md) for the functional vs.
observational plugin split.

## Monorepo layout

| Package | Purpose |
| --- | --- |
| `packages/core` | Specs (TypeBox), executor, renderer, validator, bundle exporter, plugin interfaces |
| `packages/providers/mock` | Deterministic mock provider (offline/tests) |
| `packages/providers/openai-compatible` | Fetch-based OpenAI-compatible provider + delegated-agent placeholder |
| `packages/registries/filesystem` | Filesystem prompt/pipeline/schema registry |
| `packages/registries/git` | Minimal Git registry (records commit SHA) |
| `packages/stores/filesystem` | Filesystem result store |
| `packages/cli` | `llm-pipe` CLI |
| `packages/server` | Fastify REST API + `public/openai.json` |
| `packages/mcp-server` | Compact 8-tool MCP server |

## Getting started

Requires Node.js **22+** and pnpm. (Node 22 is required by the pinned
`pnpm@11.3.0`; see the "What's added" §4 above for the why.)

```bash
pnpm install
pnpm build
pnpm test
```

### Run the example SWOT pipeline (offline, mock provider)

```bash
node packages/cli/dist/index.js run swot_recursive \
  examples/inputs/sample-topic.md --providers mock --depth 1 --export run_bundles
```

Other CLI commands:

```bash
node packages/cli/dist/index.js list-pipelines
node packages/cli/dist/index.js validate-pipeline swot_recursive
node packages/cli/dist/index.js get-run <run-id>
node packages/cli/dist/index.js export-run <run-id> --out run_bundles
```

By default the CLI reads pipelines from `examples/` (override with `--registry`
or `$LLM_PIPE_REGISTRY`) and writes runs to `.runs/` (override with `--store`
or `$LLM_PIPE_STORE`).

Every CLI command, flag, and exit code is documented in
[`docs/cli-reference.md`](./docs/cli-reference.md).

### REST server

```bash
PORT=8787 node packages/server/dist/server.js
curl localhost:8787/pipelines
curl localhost:8787/openai.json
```

Every HTTP route (params, responses, status codes, auth) is documented in
[`docs/rest-reference.md`](./docs/rest-reference.md).

### MCP server

```bash
node packages/mcp-server/dist/server.js   # speaks MCP over stdio
```

See [`docs/mcp.md`](./docs/mcp.md) and [`docs/openai-json.md`](./docs/openai-json.md).

### Docker (combined entrypoint)

```bash
docker build -t calane:latest .
docker run --rm -p 8787:8787 \
  -e ANTHROPIC_API_KEY -e OPENAI_API_KEY \
  -v calane-data:/data calane:latest
# then: curl http://localhost:8787/health
```

Same boot model as `render.yaml` (runs `packages/server/dist/combined.js` —
REST + OpenAPI + OAuth discovery + MCP Streamable HTTP at `/mcp` — on one
port, with persistent state on `/data`). Full setup, env vars, smoke tests,
and known issues in [`docs/deploy-docker.md`](./docs/deploy-docker.md).

## End-to-end scenarios

Practical, runnable walkthroughs that pair the per-surface references with real
use-cases (run → sign → verify; resume/diff/replay/stats; REST/MCP/A2A;
connecting an external or GitHub registry) live in
[`docs/scenarios/`](./docs/scenarios/README.md). Each runnable block is exercised
offline by a CI test so the docs can't silently rot.

## The 8-tool surface

To respect the OpenAI tool/action surface limit (~30 tools), both MCP and
`openai.json` expose **exactly 8 coarse-grained tools** — never one tool per
internal function: `run_pipeline`, `get_run_result`, `list_pipelines`,
`validate_pipeline`, `export_run_bundle`, `rerun_channel`, `list_runs`,
`get_pipeline_spec`.

## Schema rule

TypeBox is the single source of truth; Ajv validates. No Zod anywhere in the
codebase. See [`docs/schema-rule.md`](./docs/schema-rule.md).

## Providers

- `mock` — deterministic, schema-synthesizing (offline + tests).
- `openai-compatible` — any OpenAI-style `/chat/completions` endpoint; key from
  the env var named by `apiKeyEnv` (default `OPENAI_API_KEY`).
- `delegated-agent` — placeholder for `delegated_agent` execution mode.

The provider interface is designed to admit future OpenAI, Anthropic, Ollama,
LiteLLM, Portkey, MCP-agent, and custom HTTP providers without core changes.

## Run bundles

See [`docs/run-bundle.md`](./docs/run-bundle.md) for the exact bundle layout.

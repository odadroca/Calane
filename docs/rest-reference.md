# REST reference

Complete reference for every HTTP route the Fastify server exposes. These routes
back the **same 8 coarse-grained tools** as [MCP](./mcp.md) and
[`openai.json`](./openai-json.md) — there is no per-internal-function route.
Several routes (resume, diff, stats, rerun-channel, federation, A2A) fold into
that surface rather than adding new external tools.

## Starting the server

```bash
pnpm build
PORT=8787 node packages/server/dist/server.js   # or: pnpm server
curl localhost:8787/health
```

Default port is `8787` (override with `PORT`). For remote deployment see
[deploy-render.md](./deploy-render.md).

## Authentication

Auth is **disabled** (open) when no token and no OIDC config are present — this is
local/dev. It is **enforced** when either is configured:

- **Static bearer token** — set `CALANE_API_TOKEN`, or list tokens in
  `~/.calane/auth.toml`. Present it as `Authorization: Bearer <token>`. This is
  the CLI / Custom GPT path.
- **OAuth 2.1 access token** — when OIDC is configured, RS256 JWTs are accepted
  *in addition* to the static token (dual auth). The kernel is a **resource
  server** only. See [auth.md](./auth.md).

When auth is enforced, unauthenticated calls to protected routes return `401`
with `{ "error": "unauthorized: valid bearer token required" }`. If OIDC is
configured the response also carries a `WWW-Authenticate` header pointing at the
protected-resource metadata.

**Public paths** (never gated): `/health`, `/openai.json`, `/openapi.json`,
`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
`/mcp` (enforces its own per-call auth), and the A2A discovery cards
(`/.well-known/agent-card.json`, `/.well-known/agent-card/*`). The A2A
*invocation* endpoint (`POST /a2a/:pipelineId`) is gated.

## Configuration (env)

| Variable | Meaning |
| --- | --- |
| `PORT` | Listen port (default `8787`). |
| `LLM_PIPE_REGISTRY` | Registry root (default `examples`). |
| `LLM_PIPE_STORE` | Store root (default `.runs`). |
| `CALANE_STORE_DRIVER=sqlite` / `CALANE_SQLITE_PATH` | Use the SQLite store (required for `/stats/*`; recommended for persistent disks). |
| `CALANE_API_TOKEN` | Static bearer token (enables auth). |
| `CALANE_PUBLIC_URL` | Public base URL echoed in `openapi.json` `servers[]` and A2A cards. |
| `LLM_PIPE_CALLBACK_WINDOW_MS` | Replay window for delegated-agent callbacks (default `3600000`). |
| `CALANE_KEYS_DIR`, `CALANE_TRUST_CONFIG`, `CALANE_FEDERATION_TOKEN` | Signing keypair + federation trust (see [federation.md](./federation.md)). |

All request/response bodies are JSON. The `RunResult` and `ResolvedPipeline`
shapes are defined by TypeBox in `packages/core` (see [schema-rule.md](./schema-rule.md)).

---

## Health & discovery

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | public | Liveness. Returns `{ "status": "ok" }`. |
| GET | `/openai.json` | public | Static OpenAI Actions manifest (the 8-tool surface). See [openai-json.md](./openai-json.md). |
| GET | `/openapi.json` | public | OpenAPI 3.1 document, built dynamically so `servers[].url` reflects `CALANE_PUBLIC_URL`. See [openapi-action.md](./openapi-action.md). |
| GET | `/.well-known/oauth-protected-resource` | public | OAuth protected-resource metadata (only when OIDC configured). |
| GET | `/.well-known/oauth-authorization-server` | public | Pointer to the configured authorization server (only when OIDC configured). |

---

## Runs

### `POST /runs` → `run_pipeline`

Execute a pipeline and store the run.

- **Body**: `{ "pipelineId": string, "input": string, "options"?: { providers?, depth?, maxConcurrency?, timeoutMs?, resumeFromRunId? } }`
- **201** → the full `RunResult`.
- **400** → `{ "error": "pipelineId and input are required" }` if either is missing.

```bash
curl -X POST localhost:8787/runs -H 'content-type: application/json' \
  -d '{"pipelineId":"swot_recursive","input":"...","options":{"providers":["mock"]}}'
```

### `POST /runs/:runId/resume`

Resume a prior partial run (folds into `run_pipeline` via
`options.resumeFromRunId`; no separate external tool).

- **201** → the resumed `RunResult`.
- **404** → `run_not_found` (structured `ResumeError`).
- **409** → not resumable (structured `ResumeError`).

### `GET /runs` → `list_runs`

Returns `{ "runs": string[] }` (stored run ids).

### `GET /runs/:runId` → `get_run_result`

Returns the stored `RunResult`. **404** `{ "error": "run not found" }` if unknown.

### `GET /runs/:idA/diff/:idB`

Structural + content diff of two runs (folds into the run-inspection surface).

- **200** → the diff object.
- **404** → `{ "error": "run not found: <id>" }` if either run is missing.
- **409** → `pipeline_mismatch` (structured) when the two runs are of different
  pipeline definitions.

### `POST /runs/:runId/rerun-channel` → `rerun_channel`

Re-run a single channel using the prior run's input. Re-executes the pipeline
from that input and returns the one requested channel.

- **Body**: `{ "channelId": string }`.
- **200** → `{ "runId": string, "channel": ChannelResult }`.
- **400** → `{ "error": "channelId is required" }`.
- **404** → run not found, or `channel not found: <id>`.

### `GET /runs/:runId/export` → `export_run_bundle`

Export a stored run as a reproducible bundle.

- **Query**: `outDir?` (default a temp dir under the OS tmpdir), `redacted=true`
  to redact obvious secrets.
- **200** → the exporter result (`{ bundlePath, … }`).
- **404** → run not found.

### `POST /runs/:runId/channels/:channelId/callback`

Delegated-agent callback sink. Verifies an HMAC-SHA256 signature against the
per-channel secret minted at dispatch and consumes the nonce to block replays.
See [delegated-agents.md](./delegated-agents.md).

- **Headers/body**: signature via `x-callback-signature` header or `signature`
  field; body must include `nonce`, `timestamp`, and `result`.
- **200** → `{ "accepted": true, runId, channelId }`.
- **400** → missing `nonce`/`timestamp`/`result`.
- **401** → no signing secret, or signature invalid/expired/replayed.

---

## Pipelines

### `GET /pipelines` → `list_pipelines`

Returns `{ "pipelines": string[] }`.

### `GET /pipelines/:pipelineId` → `get_pipeline_spec`

Returns the `ResolvedPipeline` (resolved spec + source metadata + `pipelineHash`).
**404** if not found.

### `POST /pipelines/:pipelineId/validate` → `validate_pipeline`

Validates the **stored** pipeline by id.

- **200** → `{ valid, pipelineId, issues[], pipelineHash }`.
- **404** → `{ valid: false, pipelineId, issues: [{ check: "spec_schema", … }] }`
  when the pipeline is not found.

### `GET /pipelines/:namespace/:id` (federation: serve)

Serves the **raw** pipeline spec by namespace/id so another instance can fetch,
hash, and cache it verbatim. Resolution only — not a marketplace (no
publication/curation/ratings). The local pipeline id must match `:id`.

- **200** → the raw spec JSON (string body, `content-type: application/json`).
- **404** → `{ "error": "pipeline not found: <id> (…)" }`.

---

## Stats (SQLite store only)

Cross-run aggregates. With a non-SQLite store these return **409** with the
structured `stats_requires_sqlite` error. See [stats.md](./stats.md). A `range`
query accepts `7d`, `24h`, or an ISO lower bound.

| Method | Path | Query | Returns |
| --- | --- | --- | --- |
| GET | `/stats/cost` | `pipeline?`, `range?` | Cost over time, bucketed by day. |
| GET | `/stats/latency` | `provider?`, `range?` | Latency by provider. |
| GET | `/stats/failures` | `range?`, `top?` | Validation failure rate + top failed channels. |

---

## Federation

See [federation.md](./federation.md). All references are canonical
`calane://run/<hash>` strings, URL-encoded in the path.

### `GET /federated/bundles/:ref` (serve)

Returns a signed bundle for the local run matching the requested canonical
reference: `{ "files": { <name>: <contents> } }`. **400** if `:ref` is not a
canonical run reference; **404** if no local run matches.

### `GET /federated/runs/:ref?instance=<id>` (fetch)

Fetch a run from a trusted remote, verify its signature against the allowlisted
key, and store it as a foreign (read-only) run.

- **Query**: `instance` (required) — allowlisted id or base URL.
- **201** → fetched + stored (or **200** if already present).
- **400** → not a canonical reference, or missing `instance`.
- **403** → `untrusted_instance`.
- **502** → upstream fetch/verify failure.

### `GET /federated/runs`

Lists locally-stored foreign run hashes with provenance:
`{ "runs": Provenance[] }`.

---

## A2A (Agent2Agent)

Exposes each pipeline as a synchronous, non-streaming A2A agent, conforming to
the vendored schema at `vendor/a2a/a2a.schema.json`. See [a2a.md](./a2a.md). The
discovery cards are public; invocation is auth-gated.

### `GET /.well-known/agent-card.json` (public)

Index AgentCard listing each pipeline as a skill and pointing at the per-pipeline
cards under `supportedInterfaces`.

### `GET /.well-known/agent-card/:pipelineId` (public)

Per-pipeline AgentCard. Declares `streaming: false`, `pushNotifications: false`,
one JSON-RPC interface at `/a2a/:pipelineId`, and (only when auth is enforced) a
bearer security scheme. **404** if the pipeline is unknown.

### `POST /a2a/:pipelineId` (auth-gated)

JSON-RPC 2.0 `message/send` (alias `SendMessage`) mapping to **exactly one**
`run_pipeline`. The input is the joined text/data parts of `params.message`.

- **200** → `{ jsonrpc: "2.0", id, result: { task } }` where `task` is a single
  COMPLETED (or FAILED) A2A Task carrying the run's synthesis as an artifact.
- **400** → `-32600` invalid JSON-RPC; `-32601` unsupported method (only
  `message/send` is synchronous); `-32602` empty message parts.
- **404** → `-32004` pipeline not found.
</content>

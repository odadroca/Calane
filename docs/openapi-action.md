# OpenAPI Action for a Custom GPT (R3)

The server serves an **OpenAPI 3.1** document describing its coarse REST surface
so a single Custom GPT can call it as an [Action]. This is the lowest-effort path
to a working external client: it reuses the existing S11 bearer token (no OAuth).

> This document is **distinct** from `server/public/openai.json`. `openai.json`
> is the plugin-manifest that pins the frozen 8-tool surface; `openapi.json` is
> the REST contract a GPT Action imports. Both describe the same 8 operations.

## Where it lives

- **`GET /openapi.json`** — served dynamically by the running server. The
  `servers[].url` reflects the `CALANE_PUBLIC_URL` env var at runtime, so a
  deployed instance advertises its real public URL. This route is public (no
  bearer token required), like `GET /health` and `/openai.json`.
- **`server/public/openapi.json`** — a committed copy (with a localhost server
  URL) for offline inspection and diffing. The live route is authoritative.

The document is **derived from the TypeBox single-source schemas**
(`RunRequest`, `RunResult` re-exported from `@llm-pipe/core`). TypeBox emits JSON
Schema by construction, so those objects drop straight into
`components.schemas` — no second schema system, no Zod.

## Operations

The document lists exactly the operations backing the 8 tools:

| operationId        | method + path                         |
| ------------------ | ------------------------------------- |
| `run_pipeline`     | `POST /runs`                          |
| `list_runs`        | `GET /runs`                           |
| `get_run_result`   | `GET /runs/{runId}`                   |
| `rerun_channel`    | `POST /runs/{runId}/rerun-channel`    |
| `export_run_bundle`| `GET /runs/{runId}/export`            |
| `list_pipelines`   | `GET /pipelines`                      |
| `get_pipeline_spec`| `GET /pipelines/{pipelineId}`         |
| `validate_pipeline`| `POST /pipelines/{pipelineId}/validate` |

OpenAI's Action field-length limits are respected: every operation
summary/description is ≤300 chars and every parameter description is ≤700 chars.
`assertOpenAiLimits()` enforces this and the build test calls it.

## Wiring it into a Custom GPT

1. Deploy the server with a public HTTPS URL (see `docs/deploy-render.md`) and
   set `CALANE_PUBLIC_URL` to that URL and `CALANE_API_TOKEN` to a secret token.
2. In the GPT editor, **Create new action** → **Import from URL** and point it at
   `https://<your-host>/openapi.json` (or paste the document).
3. Under **Authentication**, choose **API Key**, **Auth Type: Bearer**, and paste
   the same value as `CALANE_API_TOKEN`. The Action sends
   `Authorization: Bearer <token>` on every call.
4. Save. The GPT can now call `run_pipeline`, `get_run_result`, etc.

## Security

- Every operation requires the bearer token except the public document itself.
- The token is the S11 `CALANE_API_TOKEN` (env-only; never committed/logged).
  See `docs/auth.md`.

[Action]: https://platform.openai.com/docs/actions

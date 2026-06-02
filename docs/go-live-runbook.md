# Calane — "Go Live" Runbook

One ordered checklist for taking **a single Calane instance** online for **one
operator**, stitching together the four deployment docs:

- [`docs/deploy-render.md`](./deploy-render.md) — the Render host (R4)
- [`docs/remote-mcp.md`](./remote-mcp.md) — Streamable HTTP MCP transport (R1)
- [`docs/openapi-action.md`](./openapi-action.md) — the Custom GPT Action (R3)
- [`docs/a2a.md`](./a2a.md) — A2A AgentCard exposure (R5)

Auth (R2, OAuth 2.1 + PKCE) and the static bearer (S11) are covered in
[`docs/auth.md`](./auth.md); this runbook only references them where a step needs
them.

> **Scope reminder (CLAUDE.md §A1).** This is a **single-tenant**, self-hosted
> deployment: exactly one operator, no per-user accounts, no data isolation, no
> billing, no multi-tenancy. Everything below assumes that boundary.

The combined entrypoint (`packages/server/dist/combined.js`) serves **all four
surfaces on one port**: REST + `GET /openapi.json` + OAuth discovery, the MCP
Streamable HTTP transport at `/mcp`, and the A2A `.well-known` + `/a2a/*` routes.

---

## Phase 0 — Pre-flight (local, before you touch Render)

- [ ] `pnpm install && pnpm build && pnpm test` — expect **217/217** green.
- [ ] Repo is pushed to a Git provider Render can build from.
- [ ] Decide the auth posture:
  - **Custom GPT only** → a static bearer (`CALANE_API_TOKEN`) is enough; OAuth
    is optional.
  - **Claude mobile/web connector** → you need an OAuth 2.1 + PKCE IdP (issuer +
    audience + JWKS). See `docs/auth.md`.
- [ ] If using A2A: confirm the vendored snapshot is acceptable as-is. Calane
  advertises the bundle's `version: "v1"` string and does **not** claim a tagged
  A2A release. To advertise a specific tagged version, re-vendor first (see
  `docs/a2a.md` → "Vendored schema").
- [ ] Generate the static bearer: `openssl rand -hex 32` → this is
  `CALANE_API_TOKEN`. Keep it out of git.

## Phase 1 — Provision the Render host (from `deploy-render.md`)

- [ ] Render account on a **paid tier** (a persistent disk is required; the free
  tier's ephemeral storage loses runs on redeploy).
- [ ] Render → **New → Blueprint** → point at the repo; it reads `render.yaml`.
- [ ] Confirm the blueprint provisions: one Node **web service**, a **1 GB disk
  mounted at `/data`**, a `/health` check.
- [ ] Set the secret env vars (all `sync: false` — never committed):
  - [ ] `CALANE_API_TOKEN` — the bearer from Phase 0.
  - [ ] `ANTHROPIC_API_KEY` — only if you use the Anthropic provider.
  - [ ] `CALANE_PUBLIC_URL` — the service's public URL (e.g.
    `https://calane.onrender.com`); the OpenAPI `servers[].url` and the A2A
    provider URL reflect it.
  - [ ] OAuth (only for the Claude connector): `CALANE_OIDC_ISSUER`,
    `CALANE_OIDC_AUDIENCE`, `CALANE_OIDC_JWKS_URI`.
- [ ] Confirm persistence env is in place (set by `render.yaml`):
  `CALANE_STORE_DRIVER=sqlite`, `CALANE_SQLITE_PATH=/data/calane.sqlite`,
  `LLM_PIPE_STORE=/data/runs`, `CALANE_KEYS_DIR=/data/keys`.
- [ ] **Deploy.**

## Phase 2 — Liveness + persistence smoke (from `deploy-render.md`)

- [ ] `GET https://<host>/health` → `{"status":"ok"}` (no auth).
- [ ] Run a pipeline, note its `runId`, **redeploy from the dashboard**, then
  `GET /runs/{runId}` → it still returns the run (SQLite on the persistent disk).

## Phase 3 — Custom GPT Action (REST + bearer) (from `openapi-action.md`)

- [ ] `GET https://<host>/openapi.json` returns a valid OpenAPI **3.1** doc with
  `servers[].url` == `CALANE_PUBLIC_URL`.
- [ ] In the GPT editor: **Create new action → Import from URL** →
  `https://<host>/openapi.json`.
- [ ] **Authentication → API Key → Auth Type: Bearer**, value = `CALANE_API_TOKEN`.
- [ ] In the GPT, call `list_pipelines`, then `run_pipeline` with a pipeline id +
  an input → a completed run comes back.

> `openapi.json` (the REST contract the GPT imports) is **distinct** from
> `server/public/openai.json` (the frozen 8-tool plugin manifest). Both describe
> the same 8 operations; don't confuse them.

## Phase 4 — Claude remote MCP connector (Streamable HTTP + OAuth) (from `remote-mcp.md`)

- [ ] Confirm the MCP endpoint answers at `POST/GET/DELETE https://<host>/mcp`
  (sessions are keyed by the `mcp-session-id` header).
- [ ] Add a **custom connector** in Claude (web/mobile) pointing at
  `https://<host>/mcp`.
- [ ] Complete the IdP's OAuth 2.1 + PKCE consent (the interactive connector runs
  the flow itself; `S256` PKCE; Calane is a resource server only — no client
  secret). See `docs/auth.md`.
- [ ] The connector lists **exactly 8 tools**; run a pipeline end-to-end.

> Auth model: when a token/OIDC is configured, every tool call needs
> `Authorization: Bearer <token>` (static bearer **or** OAuth access token — dual
> auth). `tools/list` discovery is unauthenticated. With nothing configured, auth
> is disabled (local/dev only — do not run a public host unconfigured).

## Phase 5 — A2A AgentCard exposure (optional) (from `a2a.md`)

- [ ] `GET https://<host>/.well-known/agent-card.json` → the **index card**
  listing each pipeline as a skill (public, no token).
- [ ] `GET https://<host>/.well-known/agent-card/<pipelineId>` → the
  **per-pipeline AgentCard** (404 for an unknown pipeline; public).
- [ ] `POST https://<host>/a2a/<pipelineId>` with a JSON-RPC 2.0 `message/send`
  body and a valid bearer/OAuth token → one **completed** A2A Task whose single
  artifact carries the run's synthesis.
- [ ] Confirm honest capabilities on the card: `streaming:false`,
  `pushNotifications:false`, `extendedAgentCard:false`. Streaming/subscribe
  methods return `-32601 Unsupported method`.

## Phase 6 — Secrets hygiene (cross-cutting)

- [ ] No secret is in `render.yaml`, `STATUS.md`, or any committed file (all
  secrets are `sync: false` / dashboard env).
- [ ] If you keep a local `~/.calane/auth.toml`, `chmod 0600` it (and
  `chmod 700 ~/.calane`).
- [ ] Public-by-design routes (no token): `GET /health`, `GET /openapi.json`,
  `GET /openai.json`, the OAuth discovery docs, and the A2A `.well-known/agent-card*`
  cards. Everything else is gated.

---

## Go-live exit criteria

You are live when **all** of these pass on the deployed host:

- [ ] `/health` is green and runs survive a redeploy.
- [ ] The Custom GPT imports `openapi.json` and completes a `run_pipeline`.
- [ ] (If used) the Claude connector lists 8 tools and completes a run via OAuth.
- [ ] (If used) an A2A client fetches a card and a `message/send` returns a
  completed Task.
- [ ] No secret is committed anywhere.

---

## Glossary

- **A2A (Agent2Agent)** — an inter-agent protocol. Calane exposes each pipeline
  as an **AgentCard** (a JSON manifest at a `.well-known` path) plus a JSON-RPC
  `message/send` endpoint that maps to exactly one `run_pipeline`. Synchronous and
  non-streaming only.
- **AgentCard** — the A2A manifest describing an invocable agent (here, one
  pipeline): its name, version, capabilities, skills, and invocation interface.
- **Bearer token** — the static `CALANE_API_TOKEN` (the S11 token) sent as
  `Authorization: Bearer <token>`. The lowest-effort auth path; used by the Custom
  GPT.
- **Channel** — one unit of work inside a pipeline (a provider call or a delegated
  agent), validated against a JSON Schema.
- **Combined entrypoint** — `packages/server/dist/combined.js`: one process that
  serves REST + OpenAPI + OAuth discovery **and** the MCP `/mcp` transport **and**
  the A2A routes on a single port, against one disk.
- **Custom GPT Action** — an OpenAI Custom GPT calling Calane's REST surface via
  the imported `openapi.json`, authenticated with the bearer token.
- **Dual auth** — the surfaces accept **either** the static bearer (S11) **or** an
  OAuth 2.1 access token (R2). Whichever is presented and valid is accepted.
- **IdP (Identity Provider)** — the third-party OAuth/OIDC service (Auth0, Clerk,
  WorkOS, Stytch, Keycloak, …). Calane is a **resource server** only; it never
  implements its own accounts or login UI.
- **JWKS (JSON Web Key Set)** — the IdP's published public keys, fetched from
  `CALANE_OIDC_JWKS_URI`, used to verify RS256 access-token signatures.
- **MCP (Model Context Protocol)** — the protocol Claude connectors speak. Calane
  exposes the same **8 tools** over both stdio (local) and Streamable HTTP (remote).
- **OAuth 2.1 + PKCE** — the interactive auth flow for the Claude connector. `S256`
  PKCE; no client secret shipped (Calane is a resource server).
- **OpenAPI 3.1** — the REST contract document served at `GET /openapi.json`,
  derived from the TypeBox single-source schemas; what the Custom GPT imports.
- **`openai.json` vs `openapi.json`** — `openai.json` is the **frozen 8-tool
  plugin manifest**; `openapi.json` is the **REST contract** a GPT Action imports.
  Different files, same 8 operations.
- **Persistent disk** — the Render disk mounted at `/data` holding the SQLite DB,
  run store, callback secrets, and the instance signing key. Required so runs and
  the instance identity survive a redeploy.
- **Pipeline** — a named, versioned, schema-validated multi-channel analysis
  workflow; the unit a caller executes via `run_pipeline`.
- **Run bundle** — the exported, reproducible artifact of a run (metadata, raw +
  parsed outputs, validation reports, optional signature).
- **Single-tenant** — exactly one operator/owner; all runs and data belong to that
  operator. No per-user isolation (CLAUDE.md §A1).
- **Streamable HTTP** — the current MCP HTTP transport (SSE was deprecated in early
  2026). Stateful, keyed by the `mcp-session-id` header; served at `/mcp`.
- **Synthesis** — the pipeline's final adjudication channel; its output is what the
  A2A Task returns as its artifact.
- **8-tool surface** — the frozen external tool set: `run_pipeline`,
  `get_run_result`, `list_pipelines`, `validate_pipeline`, `export_run_bundle`,
  `rerun_channel`, `list_runs`, `get_pipeline_spec`. Never exceeded.

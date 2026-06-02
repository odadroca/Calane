# Deploying ONE Calane instance to Render (R4)

This deploys a **single instance for a single operator** (single-tenant per
`CLAUDE.md` §A1). It is not a multi-tenant product: there are no per-user
accounts, no data isolation between users, no billing. All runs belong to the one
operator.

The `render.yaml` blueprint at the repo root provisions one Node **web service**
with a **persistent disk** so runs survive redeploys, a `/health` check, and
env-var secrets. The service runs the **combined entrypoint**
(`packages/server/dist/combined.js`), which serves on one port:

- the REST surface + `GET /openapi.json` (Custom GPT Action) + OAuth discovery, and
- the MCP **Streamable HTTP** transport at **`/mcp`** (remote Claude connector).

## Prerequisites

- A Render account. A **paid tier is required for a persistent disk** (the free
  tier has ephemeral storage; runs would not survive a redeploy).
- The repo pushed to a Git provider Render can build from.

## One-time setup

1. In Render, **New → Blueprint**, point it at the repo; it reads `render.yaml`.
2. Render creates the `calane` web service with a 1 GB disk mounted at `/data`.
3. Set the secret env vars (marked `sync: false`, so they are **never** committed):
   - `CALANE_API_TOKEN` — the S11 bearer token for the CLI and the Custom GPT.
     Generate a strong random value (e.g. `openssl rand -hex 32`).
   - `ANTHROPIC_API_KEY` — if you use the Anthropic provider.
   - `CALANE_PUBLIC_URL` — the service's public URL (e.g.
     `https://calane.onrender.com`); the OpenAPI `servers[].url` reflects it.
   - OAuth (optional, to enable the interactive Claude connector):
     `CALANE_OIDC_ISSUER`, `CALANE_OIDC_AUDIENCE`, `CALANE_OIDC_JWKS_URI`
     (see `docs/auth.md`).
4. Deploy.

### Persistent storage

`render.yaml` sets:

```
CALANE_STORE_DRIVER = sqlite
CALANE_SQLITE_PATH  = /data/calane.sqlite   # on the mounted disk
LLM_PIPE_STORE      = /data/runs            # callback secrets, foreign runs
CALANE_KEYS_DIR     = /data/keys            # instance signing key
```

Because the SQLite file lives on the persistent disk, **runs survive a
redeploy**. SQLite also unlocks the cross-run stats endpoints (`/stats/*`).

> Verify after a redeploy: run a pipeline, note its `runId`, redeploy from the
> dashboard, then `GET /runs/{runId}` — it should still return the run. The
> `packages/server/tests/deploy.test.ts` "persists across restart" test exercises
> this offline against the env-driven SQLite path.

## Secrets discipline

- Tokens/keys are **env-only**; none are committed (`sync: false` in the
  blueprint). Never paste a secret into `render.yaml`, `STATUS.md`, or any file.
- If you keep a local `~/.calane/auth.toml`, `chmod 0600` it (see `docs/auth.md`).
- `GET /health` is the only unauthenticated REST route once auth is enabled
  (`/openapi.json`, `/openai.json`, and the OAuth discovery docs are also public
  by design; `/mcp` runs its own per-tool-call auth).

## Smoke tests (run after deploy)

These require the live host; they are the operator's manual verification.

### Custom GPT (REST, bearer)

- [ ] `GET https://<host>/health` → `{"status":"ok"}` (no auth).
- [ ] `GET https://<host>/openapi.json` imports cleanly as a Custom GPT Action
      (see `docs/openapi-action.md`); set Action auth to API-Key / Bearer with
      `CALANE_API_TOKEN`.
- [ ] In the GPT, call `list_pipelines`, then `run_pipeline` with a pipeline id
      and an input → a completed run is returned.

### Claude mobile / web (remote MCP, OAuth)

- [ ] Add a custom connector pointing at `https://<host>/mcp`.
- [ ] Complete the IdP's OAuth 2.1 + PKCE consent (see `docs/auth.md` and
      `docs/remote-mcp.md`).
- [ ] The connector lists 8 tools; run a pipeline end-to-end.

### Persistence

- [ ] Note a `runId`, trigger a redeploy, then fetch the run again — it persists.

## Out of scope (per §A1)

Hostinger / shared hosting (unsuitable for long-running Node + streaming),
multi-region, autoscaling, and any multi-tenant isolation. This is one tenant on
one host.

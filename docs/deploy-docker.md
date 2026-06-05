# Deploying ONE Calane instance in Docker

This deploys a **single instance for a single operator** (single-tenant per
`CLAUDE.md` §A1). It is not a multi-tenant product: there are no per-user
accounts, no data isolation between users, no billing. All runs belong to the
one operator.

The `Dockerfile` at the repo root builds a self-contained image that runs the
**combined entrypoint** (`packages/server/dist/combined.js`) on one port:

- the REST surface + `GET /openapi.json` (Custom GPT Action) + OAuth discovery,
  and
- the MCP **Streamable HTTP** transport at **`/mcp`** (remote Claude connector).

This is the same boot model as [`deploy-render.md`](./deploy-render.md) — the
two deployment paths are not alternatives that diverge at runtime; they're the
same kernel started the same way, on different hosts.

## Prerequisites

- Docker Engine **20.10+** (BuildKit on by default; multi-stage required).
  Any host that runs Docker — Docker Desktop, a Linux server, a NAS — works.
- About 1.5 GB of disk for the base image + build cache. The final image is
  ~570 MB; the build cache adds the apt deps for the native compile of
  `better-sqlite3` (python3 / make / g++).

Nothing else. Node, pnpm, and the build toolchain all live inside the builder
stage — you do **not** install them on the host.

## Build

From the repo root:

```bash
docker build -t calane:latest .
```

The build is multi-stage:

1. **builder** (`node:22-bookworm-slim` + python3/make/g++) — `corepack enable
   pnpm@11.3.0`, `pnpm install --frozen-lockfile`, `pnpm build`. Compiles
   `better-sqlite3` natively against the bookworm glibc.
2. **runtime** (`node:22-bookworm-slim`, no build tools) — copies the built
   tree from the builder, sets a non-root user (`uid 10001`), `EXPOSE 8787`,
   `VOLUME /data`, healthcheck via Node 20+ `fetch` (no `curl` in the image),
   `CMD ["node", "packages/server/dist/combined.js"]`.

The `.dockerignore` keeps the build context to source + lockfile + workspace
manifests + `examples/` + `vendor/` (the A2A schema is needed at runtime, not
just a doc). Governance markdown, tests, render.yaml, `.github`, and local
state (`.runs`, `.claude`, `.CALANE*`) are excluded.

## Run

Minimum:

```bash
docker run --rm -p 8787:8787 calane:latest
```

Operational form — named, with provider keys passed in, persistent volume,
and the API token:

```bash
docker run -d --name calane -p 8787:8787 \
  -e CALANE_API_TOKEN="$(openssl rand -hex 32)" \
  -e ANTHROPIC_API_KEY \
  -e OPENAI_API_KEY \
  -e MISTRAL_API_KEY \
  -e GEMINI_API_KEY \
  -v calane-data:/data \
  calane:latest
```

Notes:

- The unquoted `-e VAR` form forwards the host's current value; never bake
  secrets into the image, the compose file, or the registry.
- The `-v calane-data:/data` mount is what makes runs survive container
  replacement — see "Persistent storage" below.
- For an interactive single-shot run (e.g. the CLI inside the container):
  `docker run --rm calane:latest node packages/cli/dist/index.js list-pipelines`.

## Environment variables

Defaults that come pre-set in the image (override only if you have a reason to):

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Server listen port. |
| `NODE_ENV` | `production` | Node runtime mode. |
| `CALANE_STORE_DRIVER` | `sqlite` | SQLite result store. |
| `CALANE_SQLITE_PATH` | `/data/calane.sqlite` | DB file on the persistent volume. |
| `LLM_PIPE_STORE` | `/data/runs` | Callback secrets + fetched foreign runs. Without this on the mounted volume the kernel default `./.runs` writes them into the container layer (ephemeral). |
| `CALANE_KEYS_DIR` | `/data/keys` | Per-instance Ed25519 signing key (S21). Without this on the mounted volume the kernel default `~/.calane/keys` writes it into the container layer — every container replacement would re-generate the key and invalidate previously-signed bundles. |

Secrets to pass at run-time (never baked into the image):

| Var | When |
| --- | --- |
| `CALANE_API_TOKEN` | S11 bearer token for the CLI and Custom GPT Action. Generate with `openssl rand -hex 32`. |
| `ANTHROPIC_API_KEY` | Anthropic provider channels (and the distillation pipeline's synthesis). |
| `OPENAI_API_KEY` | OpenAI-compatible provider channels. |
| `MISTRAL_API_KEY` | Mistral channels (via the openai-compatible adapter). |
| `GEMINI_API_KEY` | Gemini channels (via the openai-compatible adapter at the Google `/v1beta/openai` endpoint). |
| `CALANE_PUBLIC_URL` | Optional. Sets the OpenAPI `servers[].url`. Use the URL clients will reach the container on (`https://...` if behind TLS termination). |
| OAuth (optional) | `CALANE_OIDC_ISSUER`, `CALANE_OIDC_AUDIENCE`, `CALANE_OIDC_JWKS_URI` — only if exposing the interactive Claude remote-MCP connector path. See [`docs/auth.md`](./auth.md). |

## Persistent storage

The image declares `VOLUME ["/data"]`. The combined entrypoint writes to:

```
/data/calane.sqlite                  # runs (CALANE_SQLITE_PATH)
/data/runs/...                       # callback secrets, foreign runs (LLM_PIPE_STORE)
/data/keys/...                       # instance signing key (CALANE_KEYS_DIR)
```

All three paths are **baked into the image** as `ENV` defaults (see the table
above), so a plain `-v calane-data:/data` mount is enough — you do not need to
re-pass `LLM_PIPE_STORE` / `CALANE_KEYS_DIR` on `docker run`. Override only if
you want them outside `/data`.

Mount a named volume (`-v calane-data:/data`) or a bind mount
(`-v /path/on/host:/data`) and runs survive across container restarts and image
upgrades. Without a mount, `/data` is ephemeral and every `docker rm` loses
your run history.

> Verify after a restart: run a pipeline, note its `runId`, `docker restart
> calane`, then `GET /runs/{runId}` — it should still return the run. The
> `packages/server/tests/deploy.test.ts` "persists across restart" test covers
> this offline against the same env-driven SQLite path.

## Secrets discipline

- Tokens and provider keys are passed **only via env at `docker run`**. Do not
  put them in a `Dockerfile`, a built image, a `docker-compose.yml` checked in
  to a repo, or any file that gets pushed. Use `--env-file <file>` with the
  file outside the repo, or a secrets store.
- The container runs as a **non-root** user (`uid 10001`). Bind mounts need
  the corresponding host UID/GID to be writable, or run with `--user $(id -u):$(id -g)`.
  Named volumes inherit ownership and don't need this.
- `GET /health` is the only unauthenticated REST route once auth is enabled
  (`/openapi.json`, `/openai.json`, and the OAuth discovery docs are also public
  by design; `/mcp` runs its own per-tool-call auth).

## Smoke tests (after `docker run`)

```bash
# Healthy?
curl http://localhost:8787/health
# -> {"status":"ok"}

# OpenAPI surface looks right (exactly 8 tools by binding rule)?
curl -s http://localhost:8787/openai.json | grep -oE '"name"' | wc -l
# -> 8

# MCP Streamable HTTP transport accepting an initialize?
curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
# -> HTTP 200

# CLI inside the container?
docker exec calane node packages/cli/dist/index.js list-pipelines
# -> JSON array including the bundled and distillation pipelines

# Docker's own healthcheck (after ~30 s, three intervals)?
docker inspect --format '{{.State.Health.Status}}' calane
# -> healthy
```

If `/health` returns 200 and `docker inspect` reports `healthy`, the container
is doing the right thing. The MCP and OpenAPI probes confirm both surfaces are
live on the same port (the whole point of the combined entrypoint).

## Image details

- **Base:** `node:22-bookworm-slim` (both stages). Not alpine — `better-sqlite3`
  needs a glibc native build with python3/make/g++; alpine adds friction
  without saving meaningful size once node + node_modules is in the image.
- **Final size:** ~570 MB. Includes devDependencies because the workspace
  uses pnpm symlinks that `pnpm prune --prod` breaks; see "Known issues"
  below. Slimming to ~420 MB is feasible with `pnpm deploy --filter
  @llm-pipe/server --prod /deploy` (left as a follow-up).
- **User:** non-root `app` (uid/gid 10001).
- **Healthcheck:** Node `fetch` to `http://127.0.0.1:${PORT}/health` every
  30 s, 5 s timeout, 15 s start period, 3 retries.

## Known issues / why the Dockerfile is shaped this way

These were discovered while building the first independent image of the
upstream tree; they're documented inline in the Dockerfile too.

1. **The pinned pnpm requires Node ≥22.13.** `package.json`'s
   `packageManager` is `pnpm@11.3.0`, which imports the `node:sqlite` built-in
   (Node 22+). The previous upstream `engines.node: ">=20"` and
   `render.yaml NODE_VERSION: "20"` were inconsistent with this and would fail
   a from-scratch install. This fork bumps both to `>=22`; the Dockerfile base
   is `node:22-bookworm-slim` for the same reason.
2. **`pnpm prune --prod` breaks pnpm workspace symlinks.** Running it after
   `pnpm build` orphans workspace dependencies (e.g. `@llm-pipe/server` imports
   `@llm-pipe/mcp-server/http`; the server crashes at boot with
   `ERR_MODULE_NOT_FOUND` even though the dep IS declared correctly). The
   Dockerfile therefore does **not** prune; the canonical pnpm pattern for a
   slimmed prod tree is `pnpm deploy --filter <pkg> --prod /out`, not
   `pnpm prune --prod`. Left as a follow-up optimisation.

## Comparison with `deploy-render.md`

| | Docker | Render |
| --- | --- | --- |
| Entrypoint | `packages/server/dist/combined.js` | `packages/server/dist/combined.js` |
| Port | `8787` | `8787` |
| Persistent state | `-v calane-data:/data` | Render disk mounted at `/data` |
| Store driver | `sqlite` (`CALANE_STORE_DRIVER=sqlite`) | `sqlite` |
| Health check | Docker `HEALTHCHECK` → `/health` | Render `healthCheckPath: /health` |
| Where secrets live | `docker run -e ...` / `--env-file` | Render dashboard `sync: false` |
| Built on | `docker build` (locally) | Render builder (`pnpm install --frozen-lockfile && pnpm build`) |

Everything else — the kernel, the 8-tool surface, the per-channel retry/repair
behaviour, the run-bundle layout, the OAuth + bearer auth flows — is identical,
because both deployments serve the same code from the same combined entry.

## Out of scope (per §A1)

Multi-region images, autoscaling, sidecars, init containers, secret-injection
operators, and any multi-tenant isolation. This is one tenant on one host.
Compose/Swarm/Kubernetes manifests are intentionally not provided — the
container is a single web service and standard `docker run` is enough.

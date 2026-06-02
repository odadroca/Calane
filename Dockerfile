# Multi-stage Dockerfile for the Calane / llm-pipeline-kernel combined server.
#
# Mirrors render.yaml's boot model: runs `packages/server/dist/combined.js`,
# which serves the REST/OpenAPI/OAuth-discovery surface AND the MCP Streamable
# HTTP transport at /mcp in one process. Persistent state lives on /data
# (mount a volume for SQLite + callback secrets + instance keys to survive
# container replacement).
#
# Secrets (ANTHROPIC_API_KEY, OPENAI_API_KEY, OAuth/IdP config, the API token,
# etc.) are passed at run-time via `docker run -e` or `--env-file`. NEVER bake
# them into the image. The .dockerignore keeps build context lean.

# ---------- builder ----------
# bookworm-slim (not alpine) because better-sqlite3 needs a glibc native build
# with python3/make/g++; alpine adds friction without saving meaningful size
# once node + node_modules is in the image.
#
# Node 22 (NOT 20): the pinned pnpm@11.3.0 in package.json's `packageManager`
# field requires Node >=22.13 (it imports the `node:sqlite` built-in). This is
# inconsistent with `package.json` engines.node (>=20) and `render.yaml`
# NODE_VERSION (20) — both are too low to actually install from a clean cache.
# Either bump them to >=22 to match the lockfile's pnpm, or downgrade the
# pinned pnpm to a Node-20-compatible version (the lockfile would need
# regenerating). Tracked as a finding from the docker-deploy build.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Native build deps for better-sqlite3 (compiled in pnpm install).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pnpm via corepack at the version pinned in package.json's `packageManager`.
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

# Copy manifests first so dep install caches across source-only edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY examples ./examples
COPY vendor ./vendor

# Frozen install respects the committed lockfile (no drift between local and image).
RUN pnpm install --frozen-lockfile
RUN pnpm build

# NOTE: NOT running `pnpm prune --prod` here. In a pnpm workspace it breaks the
# workspace symlinks that the server uses to import sibling packages (e.g.
# `@llm-pipe/mcp-server/http`), and the container crashes at boot with
# ERR_MODULE_NOT_FOUND. The canonical pnpm pattern for a slimmed prod tree is
# `pnpm deploy --filter @llm-pipe/server --prod /deploy` — left as a follow-up
# (saves ~150 MB of devDependencies in the runtime image).

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Non-root user owns /app and /data. Bind-mounts will need a matching UID/GID
# (or run with --user $(id -u):$(id -g)); named volumes inherit ownership.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --shell /usr/sbin/nologin --home-dir /home/app --create-home app \
 && mkdir -p /data \
 && chown -R app:app /data

COPY --from=builder --chown=app:app /app /app

USER app

# Defaults align with render.yaml. Override per-deploy as needed.
ENV NODE_ENV=production \
    PORT=8787 \
    CALANE_STORE_DRIVER=sqlite \
    CALANE_SQLITE_PATH=/data/calane.sqlite

EXPOSE 8787
VOLUME ["/data"]

# Uses the built-in Node 20 fetch — no curl in the image. Hits /health on the
# combined entrypoint; the post-close boot regression test guards this route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Combined entrypoint: REST + OpenAPI + OAuth discovery + MCP Streamable HTTP.
# To run the CLI instead, override: `docker run ... node packages/cli/dist/index.js <args>`.
CMD ["node", "packages/server/dist/combined.js"]

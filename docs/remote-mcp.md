# Remote MCP over Streamable HTTP (R1)

The MCP server runs in two transports:

- **stdio** (default) — for local use (Claude Desktop, the CLI, tests). Unchanged.
- **Streamable HTTP** — the public-HTTPS transport that remote Claude (web/mobile)
  custom connectors require. SSE was deprecated in early 2026; Streamable HTTP is
  the current transport.

Both serve the **same 8 tools** through the same dispatch (`buildMcpServer` /
`callTool`). HTTP mode adds transport + session handling only — no new tool.

## Running the HTTP server

```sh
# Build the workspace first (pnpm build), then:
node packages/mcp-server/dist/server.js --http --port 8788
# or via the installed bin:
llm-pipe-mcp --http --port 8788
# or by env (useful on a platform that only sets PORT):
CALANE_MCP_HTTP=1 PORT=8788 llm-pipe-mcp
```

- The MCP endpoint is **`POST/GET/DELETE /mcp`**.
- An unauthenticated **`GET /health`** liveness probe is also served.
- TLS is terminated by the platform (e.g. Render); the process binds plain HTTP
  on `0.0.0.0`, so always front it with HTTPS in production.

## Sessions

Sessions are stateful, keyed by the **`mcp-session-id`** response/request header
per the Streamable HTTP spec:

1. The client's `initialize` request mints a new session id and transport.
2. Subsequent requests carry `mcp-session-id` and reuse that transport.
3. A `DELETE /mcp` tears the session down.

## Auth

When a token is configured (`CALANE_API_TOKEN` or `~/.calane/auth.toml`), every
tool call must present `Authorization: Bearer <token>`; the bearer is surfaced to
the MCP auth hook as the request `authInfo.token`. `tools/list` (discovery) is
unauthenticated. When no token is configured, auth is disabled (local/dev), the
same as stdio. The interactive remote Claude connector uses **OAuth** instead of
a static bearer — see `docs/auth.md` (R2).

## Connecting from a remote Claude connector

Point the connector at `https://<your-host>/mcp` (see `docs/deploy-render.md` for
hosting). The interactive claude.ai / mobile connector performs the OAuth flow
itself; the Messages-API MCP connector accepts a pre-obtained access token.

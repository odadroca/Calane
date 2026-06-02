# API token auth (REST + MCP)

The REST and MCP surfaces are protected by a minimal bearer-token gate. There is
**no user management, no auth UI, and no OAuth** — this is a single shared-secret
(or small token-list) check, in line with the project non-goals.

The CLI does not use auth — it runs locally against the kernel directly.

## Where tokens come from

Tokens are read from two sources, unioned:

1. **`CALANE_API_TOKEN` env var** — a single token. This is the primary path.
2. **`~/.calane/auth.toml`** — an optional config file listing one or more
   tokens.

If neither source provides a token, **auth is disabled** (open) — convenient for
local development and the default test setup. As soon as at least one token is
configured, every protected surface requires a valid token.

### Config file format

`~/.calane/auth.toml`:

```toml
# One or more valid API tokens. Plaintext (the file is sensitive — chmod 0600).
tokens = [
  "tok_live_aaaaaaaaaaaaaaaaaaaa",
  "tok_live_bbbbbbbbbbbbbbbbbbbb"
]

# A single token may also be written as:
# token = "tok_live_cccccccccccccccccccc"
```

Multiple tokens are supported (no scopes yet — any valid token grants full
access). Tokens are stored **plaintext**; the file is sensitive by definition.

**Lock the file down:**

```sh
mkdir -p ~/.calane
chmod 700 ~/.calane
chmod 0600 ~/.calane/auth.toml
```

Never commit `auth.toml` or `CALANE_API_TOKEN` to source control, and never log
token values.

## REST

- Every endpoint requires `Authorization: Bearer <token>` **except**
  `GET /health` (and the public `/openai.json` manifest), which stay open.
- Missing or invalid token → `401` with `{ "error": "unauthorized: ..." }`.

```sh
curl -H "Authorization: Bearer $CALANE_API_TOKEN" http://localhost:8787/runs
```

## MCP

- Every tool call must carry a valid token in the request auth metadata: the
  transport's `authInfo.token`, or `params._meta.token` on the call.
- `tools/list` (discovery) is unauthenticated.
- An unauthenticated/invalid call returns an MCP tool error
  (`isError: true`) with an `unauthorized` message.

## Token comparison

Tokens are compared in constant time (`crypto.timingSafeEqual`) against the
configured set to avoid timing side channels.

## OAuth 2.1 + PKCE (R2 — for the remote Claude connector)

In addition to the static bearer token above, the server can accept **OAuth 2.1
access tokens** so the interactive Claude (web/mobile) custom connector can
authenticate. This is **dual auth**: a request is allowed if it presents EITHER a
valid static `CALANE_API_TOKEN` (CLI / Custom GPT) OR a valid OAuth access token
(the connector). The static path is unchanged.

### The server is a resource server only — IdP-agnostic

The kernel does **not** implement an authorization server, account system, or any
IdP-vendor SDK. It is a standards-based **OAuth resource server**: it validates
incoming RS256 JWT access tokens against a configurable issuer + JWKS. Any
compliant IdP (Auth0, Clerk, WorkOS, Stytch, Keycloak, ...) works with **no code
change** — you only set env vars. Token verification uses `node:crypto` (JWK
import + RS256 verify); there is no new dependency and no vendor lock.

### Configuration (env only)

| Env var | Meaning |
| --- | --- |
| `CALANE_OIDC_ISSUER` | The IdP issuer; the token `iss` must equal this. |
| `CALANE_OIDC_AUDIENCE` | The resource identifier; the token `aud` must include this. |
| `CALANE_OIDC_JWKS_URI` | Where the IdP publishes its signing keys (JWKS). |
| `CALANE_OIDC_AS_METADATA_URL` | (optional) Authorization-server metadata URL advertised to clients. Defaults to `<issuer>/.well-known/oauth-authorization-server`. |

OAuth is enabled only when all three of issuer/audience/jwksUri are set. If they
are unset, only the static-token path applies (or, if no static token either,
auth is disabled for local/dev).

### What the server verifies

For each access token: `alg=RS256`, the signature against the JWKS key selected
by `kid` (the JWKS is cached and refreshed on key rotation), `iss` equals the
configured issuer, `aud` includes the configured audience, and `exp`/`nbf`.

A missing/invalid/expired token on a protected route returns **`401`** with a
**`WWW-Authenticate: Bearer resource_metadata="..."`** header pointing at the
protected-resource metadata, per the MCP authorization spec.

### Discovery metadata

When OAuth is configured, two unauthenticated discovery documents are served:

- **`GET /.well-known/oauth-protected-resource`** — declares the resource id and
  the authorization server(s) (the configured IdP), and points at the AS metadata.
- **`GET /.well-known/oauth-authorization-server`** — a **pointer** to the
  configured IdP's own metadata (templated from env). The kernel advertises no
  authorize/token endpoints of its own; it declares `S256` PKCE support so the
  public client uses PKCE end-to-end (no client secret shipped to the connector).

The actual authorization-code + PKCE exchange happens at the IdP. The connector
discovers the AS via the metadata above, runs the OAuth 2.1 + PKCE flow with the
IdP (including the IdP's own consent screen — no first-party auth UI), and
presents the resulting access token to the kernel.

Both the REST surface and the MCP Streamable HTTP transport honor OAuth tokens.

## Out of scope

- User accounts, first-party auth UI (explicit non-goal; the IdP's own consent
  screen is used).
- Issuing tokens / being an authorization server (we are a resource server).
- Token rotation infrastructure for the static token.
- Per-token scopes (a later phase may revisit).

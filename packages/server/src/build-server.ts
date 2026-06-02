import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { registerA2ARoutes } from "./a2a.js";
import { TokenAuth, bearerFromHeader } from "./auth.js";
import { type Kernel, createKernel } from "./kernel.js";
import {
  JwtVerifier,
  type OidcConfig,
  authorizationServerPointer,
  oidcConfigFromEnv,
  protectedResourceMetadata,
} from "./oidc.js";
import { buildOpenApiDocument } from "./openapi.js";
import { registerRoutes } from "./routes.js";

export interface BuildServerOptions {
  kernel?: Kernel;
  logger?: boolean;
  /** Inject a token verifier (for tests). Defaults to env/config-derived auth. */
  auth?: TokenAuth;
  /**
   * OAuth 2.1 / OIDC resource-server config (R2). When provided (or derivable
   * from env), OAuth access tokens are accepted in ADDITION to the static S11
   * bearer token (dual auth). Inject a `JwtVerifier` for tests.
   */
  oidc?: OidcConfig;
  jwtVerifier?: JwtVerifier;
}

/**
 * Paths reachable without the REST bearer hook. `/mcp` is exempt because the MCP
 * Streamable HTTP transport enforces its own per-tool-call auth (static token OR
 * OAuth) — see packages/mcp-server; the discovery + manifest docs are public.
 */
const PUBLIC_PATHS = new Set([
  "/health",
  "/openai.json",
  "/openapi.json",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/mcp",
]);

/** Build a Fastify app with pino structured logging and the REST routes. */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const kernel = options.kernel ?? createKernel();
  const auth = options.auth ?? new TokenAuth();
  const oidc = options.oidc ?? oidcConfigFromEnv();
  const jwtVerifier = options.jwtVerifier ?? (oidc ? new JwtVerifier(oidc) : undefined);

  // Dual auth hook. A request is authorized if it presents EITHER:
  //   (1) a valid static S11 bearer token (CLI / Custom GPT path), OR
  //   (2) a valid OAuth 2.1 access token (RS256 JWT) verified against the
  //       configured OIDC issuer + JWKS (interactive Claude connector path).
  // Auth is enforced when a static token OR an OIDC config is present. When
  // neither is configured, auth is disabled (local/dev). `GET /health`, the
  // public manifests, and the discovery metadata stay open.
  const authEnforced = auth.enabled || jwtVerifier !== undefined;
  app.addHook("onRequest", async (req, reply) => {
    if (!authEnforced) return;
    const url = (req.raw.url ?? "").split("?")[0] ?? "";
    if (PUBLIC_PATHS.has(url)) return;
    // A2A discovery (R5) is public so clients can fetch AgentCards before
    // authenticating; the JSON-RPC INVOCATION endpoint (/a2a/:id) stays gated.
    if (url === "/.well-known/agent-card.json" || url.startsWith("/.well-known/agent-card/")) {
      return;
    }
    const presented = bearerFromHeader(req.headers.authorization);

    // (1) Static token.
    if (auth.enabled && auth.verify(presented)) return;

    // (2) OAuth access token.
    if (jwtVerifier) {
      const verdict = await jwtVerifier.verify(presented);
      if (verdict.valid) return;
    }

    // Per the MCP authorization spec, point unauthenticated callers at the
    // protected-resource metadata so they can discover the authorization server.
    if (jwtVerifier) {
      reply.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="/.well-known/oauth-protected-resource"`,
      );
    }
    return reply.code(401).send({ error: "unauthorized: valid bearer token required" });
  });

  app.get("/health", async () => ({ status: "ok" }));

  // OAuth 2.1 / OIDC discovery metadata (R2). Served only when OAuth is
  // configured. The kernel is a RESOURCE SERVER: it advertises the configured
  // IdP as the authorization server and never implements one itself.
  if (oidc) {
    app.get("/.well-known/oauth-protected-resource", async (_req, reply) => {
      reply.header("content-type", "application/json");
      return protectedResourceMetadata(oidc);
    });
    app.get("/.well-known/oauth-authorization-server", async (_req, reply) => {
      reply.header("content-type", "application/json");
      return authorizationServerPointer(oidc);
    });
  }

  // OpenAPI 3.1 document for the Custom GPT Action (R3). Served dynamically so
  // the `servers[].url` reflects CALANE_PUBLIC_URL at runtime. Public (no token).
  app.get("/openapi.json", async (_req, reply) => {
    reply.header("content-type", "application/json");
    return buildOpenApiDocument();
  });

  registerRoutes(app, kernel);

  // A2A AgentCard exposure (R5). Per-pipeline AgentCards at the `.well-known`
  // path (public discovery) + a synchronous JSON-RPC invocation endpoint mapping
  // to exactly one run_pipeline (auth-gated via the hook above). No new MCP/
  // openai tool; REST + `.well-known` only.
  registerA2ARoutes(app, kernel, { authEnforced });

  // Serve the static openai.json manifest.
  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = join(here, "..", "public");
  app.register(fastifyStatic, { root: publicDir, prefix: "/" });

  return app;
}

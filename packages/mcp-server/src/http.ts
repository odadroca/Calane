import { randomUUID } from "node:crypto";
import {
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
  createServer,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { TokenAuth } from "./auth.js";
import { type Kernel, createKernel } from "./kernel.js";
import { JwtVerifier, oidcConfigFromEnv } from "./oidc.js";
import { type AsyncTokenVerifier, buildMcpServer } from "./server.js";

/**
 * Streamable HTTP transport for the MCP server (R1). This is the public-HTTPS
 * transport that remote Claude (web/mobile) connectors require — stdio (in
 * server.ts) stays for local use. It serves the SAME 8 tools through the same
 * `buildMcpServer` / `callTool` dispatch; this file only adds transport + HTTP
 * session handling, no new tool.
 *
 * Sessions are stateful, keyed by the `mcp-session-id` header per the MCP
 * Streamable HTTP spec: an `initialize` request mints a new session + transport;
 * subsequent requests reuse it; a DELETE tears it down.
 */

const SESSION_HEADER = "mcp-session-id";

export interface HttpMcpOptions {
  kernel?: Kernel;
  /** Inject a token verifier (for tests). Defaults to env/config-derived auth. */
  auth?: TokenAuth;
  /**
   * OAuth/OIDC access-token verifier (R2). Defaults to one built from the
   * CALANE_OIDC_* env vars when present; accepted in addition to the static
   * token (dual auth). Inject for tests.
   */
  oidc?: AsyncTokenVerifier;
  /** MCP endpoint path. Default `/mcp`. */
  path?: string;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
}

/** Extract a bearer token from an Authorization header value. */
function bearerFromHeader(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const m = value.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : undefined;
}

/**
 * Build a Node HTTP request handler that serves the MCP Streamable HTTP
 * transport at `options.path` (default `/mcp`). Returns the handler plus a
 * `closeAll()` that tears down open sessions (for clean test shutdown).
 *
 * The bearer token from `Authorization: Bearer <t>` is surfaced to the MCP
 * server as `req.auth.token`, which the tool-call auth hook in `buildMcpServer`
 * verifies. When no token is configured, auth is disabled (local/dev), matching
 * the stdio path.
 */
export function createHttpMcpHandler(options: HttpMcpOptions = {}): {
  handle: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>;
  closeAll: () => Promise<void>;
} {
  const kernel = options.kernel ?? createKernel();
  const auth = options.auth ?? new TokenAuth();
  const oidcCfg = oidcConfigFromEnv();
  const oidc = options.oidc ?? (oidcCfg ? new JwtVerifier(oidcCfg) : undefined);
  const mcpPath = options.path ?? "/mcp";
  const sessions = new Map<string, SessionEntry>();

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> => {
    const url = (req.url ?? "").split("?")[0] ?? "";

    // Unauthenticated liveness probe (handy behind a load balancer). Skipped when
    // mounted in a combined app that already serves /health (parsedBody given).
    if (parsedBody === undefined && url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url !== mcpPath && parsedBody === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    // Surface the bearer token to the MCP layer's auth hook.
    const token = bearerFromHeader(req.headers.authorization);
    if (token) (req as IncomingMessage & { auth?: { token: string } }).auth = { token };

    const sessionId = req.headers[SESSION_HEADER] as string | undefined;

    // Reuse an existing session.
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId)!;
      await transport.handleRequest(req, res, parsedBody ?? (await readBody(req)));
      return;
    }

    // New session: only valid on an initialize request (per spec).
    const body = parsedBody ?? (await readBody(req));
    if (req.method === "POST" && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const server = buildMcpServer(kernel, { auth, oidc });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // Non-initialize request without a known session id.
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session id" },
        id: null,
      }),
    );
  };

  const closeAll = async (): Promise<void> => {
    for (const { transport } of sessions.values()) {
      await transport.close();
    }
    sessions.clear();
  };

  return { handle, closeAll };
}

/** Read and JSON-parse the request body (transports want a pre-parsed body). */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    // GET/DELETE have no body.
    if (req.method === "GET" || req.method === "DELETE") {
      resolve(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

/**
 * Start a standalone Node HTTP server serving the MCP Streamable HTTP transport.
 * Returns the listening server; the caller closes it. TLS termination is handled
 * by the platform (Render), so this binds plain HTTP on 0.0.0.0.
 */
export function startHttpMcpServer(
  port: number,
  options: HttpMcpOptions = {},
): Promise<{ server: NodeHttpServer; close: () => Promise<void> }> {
  const { handle, closeAll } = createHttpMcpHandler(options);
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      resolve({
        server,
        close: async () => {
          await closeAll();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

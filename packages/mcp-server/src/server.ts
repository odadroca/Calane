import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TokenAuth, tokenFromMcp } from "./auth.js";
import { createKernel } from "./kernel.js";
import { TOOL_DEFINITIONS, callTool } from "./tools.js";

/**
 * An async access-token verifier (OAuth 2.1 / OIDC). Consulted when the static
 * S11 token check fails, enabling dual auth on the HTTP transport.
 */
export interface AsyncTokenVerifier {
  verify(token: string | null | undefined): Promise<boolean>;
}

export interface BuildMcpServerOptions {
  /** Inject a token verifier (for tests). Defaults to env/config-derived auth. */
  auth?: TokenAuth;
  /**
   * Optional OAuth/OIDC access-token verifier (R2). When present, a tool call is
   * authorized if EITHER the static token OR this verifier accepts the bearer.
   */
  oidc?: AsyncTokenVerifier;
}

/**
 * Compact MCP server exposing exactly 8 coarse-grained tools (see tools.ts).
 * Uses the low-level SDK Server so tool input schemas are plain JSON Schema,
 * honoring the no-Zod schema rule.
 *
 * When a token is configured (CALANE_API_TOKEN or ~/.calane/auth.toml), every
 * tool call must carry a matching token in the request auth metadata
 * (transport authInfo.token, or params._meta.token). Otherwise auth is disabled
 * (local use). ListTools is unauthenticated (tool discovery).
 */
export function buildMcpServer(
  kernel = createKernel(),
  options: BuildMcpServerOptions = {},
): Server {
  const server = new Server(
    { name: "llm-pipeline-kernel", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const auth = options.auth ?? new TokenAuth();
  const oidc = options.oidc;
  const authEnforced = auth.enabled || oidc !== undefined;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (authEnforced) {
      const token = tokenFromMcp(
        req.params as { _meta?: Record<string, unknown> },
        extra as { authInfo?: { token?: string } } | undefined,
      );
      // Dual auth: static S11 token OR a valid OAuth/OIDC access token.
      const staticOk = auth.enabled && auth.verify(token);
      const oauthOk = !staticOk && oidc !== undefined && (await oidc.verify(token));
      if (!staticOk && !oauthOk) {
        return {
          isError: true,
          content: [{ type: "text", text: "unauthorized: valid bearer token required" }],
        };
      }
    }
    const { name, arguments: args } = req.params;
    try {
      const result = await callTool(kernel, name, (args ?? {}) as Record<string, any>);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
    }
  });

  return server;
}

async function main() {
  const argv = process.argv.slice(2);
  const useHttp = argv.includes("--http") || process.env.CALANE_MCP_HTTP === "1";

  if (useHttp) {
    // Streamable HTTP transport (R1) for remote Claude connectors. Same 8 tools.
    const { startHttpMcpServer } = await import("./http.js");
    const portIdx = argv.indexOf("--port");
    const port = Number((portIdx >= 0 ? argv[portIdx + 1] : undefined) ?? process.env.PORT ?? 8788);
    await startHttpMcpServer(port);
    process.stderr.write(
      `llm-pipeline-kernel MCP server ready over Streamable HTTP on :${port} (8 tools)\n`,
    );
    return;
  }

  // Default: stdio transport for local use (unchanged).
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Structured operational note on stderr (stdout is the MCP transport).
  process.stderr.write("llm-pipeline-kernel MCP server ready (8 tools)\n");
}

import { pathToFileURL } from "node:url";
// Compare URLs (not paths) so the entry detection works whether the binary is
// invoked with an absolute path, a relative path, or via the bin shim — and so
// Windows backslash vs POSIX forward-slash differences do not break it. Matches
// the pattern applied to packages/server/src/server.ts in the post-close fix.
const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err}\n`);
    process.exit(1);
  });
}

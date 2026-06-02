import { pathToFileURL } from "node:url";
import { createHttpMcpHandler } from "@llm-pipe/mcp-server/http";
import { buildServer } from "./build-server.js";

/**
 * Combined single-process entrypoint for the single-tenant Render deploy (R4).
 *
 * One web service must serve BOTH client paths so both work against one
 * persistent disk / run store:
 *   - the REST surface + OpenAPI doc + OAuth discovery (Custom GPT path), and
 *   - the MCP Streamable HTTP transport at `/mcp` (remote Claude connector path).
 *
 * The same 8 tools are exposed; this only co-hosts the existing transports — no
 * new tool. The MCP handler reuses the request body Fastify already parsed.
 */
export function buildCombinedServer(port: number) {
  const app = buildServer({ logger: true });
  const mcp = createHttpMcpHandler({ path: "/mcp" });

  // Hand `/mcp` to the MCP Streamable HTTP transport. POST carries the JSON-RPC
  // body Fastify already parsed; GET (SSE) / DELETE have none. The transport runs
  // its own per-tool-call auth, so `/mcp` is exempt from the REST bearer hook
  // (see PUBLIC_PATHS in server.ts).
  app.all("/mcp", async (req, reply) => {
    reply.hijack(); // we write the raw response via the MCP transport
    const body = req.method === "POST" ? req.body : undefined;
    await mcp.handle(req.raw, reply.raw, body);
  });

  return {
    app,
    listen: async () => {
      await app.listen({ port, host: "0.0.0.0" });
      app.log.info(`Calane combined server listening on :${port} (REST + /mcp)`);
    },
    close: async () => {
      await mcp.closeAll();
      await app.close();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const { listen } = buildCombinedServer(port);
  listen().catch((err) => {
    process.stderr.write(`${err}\n`);
    process.exit(1);
  });
}

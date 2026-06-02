import { afterEach, describe, expect, it } from "vitest";
import { buildCombinedServer } from "../src/combined.js";

/**
 * R4 deploy-wiring test: the single-process combined server serves the REST /
 * OpenAPI surface AND the MCP Streamable HTTP transport at /mcp on one port (as
 * the Render web service does). Driven over a real localhost listen; no network.
 *
 * The MCP leg uses raw JSON-RPC over fetch (the MCP SDK client lives in the
 * mcp-server package, not here) — enough to prove /mcp is wired and responds.
 */

let teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const t of teardown) await t();
  teardown = [];
});

async function start(): Promise<{ base: string }> {
  const combined = buildCombinedServer(0);
  await combined.listen();
  teardown.push(combined.close);
  const addr = combined.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}` };
}

/** Parse a Streamable HTTP body that may be JSON or an SSE `data:` frame. */
function parseMaybeSse(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const line = trimmed.split("\n").find((l) => l.startsWith("data:"));
  return line ? JSON.parse(line.slice("data:".length).trim()) : undefined;
}

describe("combined REST + MCP server (R4)", () => {
  it("serves the REST OpenAPI document and health", async () => {
    const { base } = await start();
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const oa = await fetch(`${base}/openapi.json`);
    expect(oa.status).toBe(200);
    const doc = (await oa.json()) as { openapi: string };
    expect(doc.openapi).toBe("3.1.0");
  });

  it("serves the MCP transport at /mcp on the same port (initialize + tools/list)", async () => {
    const { base } = await start();

    // 1. initialize -> a session id in the response header.
    const initRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "combined-test", version: "0.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const initBody = parseMaybeSse(await initRes.text());
    expect(initBody.result.serverInfo.name).toBe("llm-pipeline-kernel");

    // 2. tools/list on the established session -> exactly 8 tools.
    const listRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(listRes.status).toBe(200);
    const listBody = parseMaybeSse(await listRes.text());
    expect(listBody.result.tools.length).toBe(8);
  });
});

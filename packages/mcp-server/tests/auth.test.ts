import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { TokenAuth, parseAuthToml, tokenFromMcp } from "../src/auth.js";
import { buildMcpServer } from "../src/server.js";

describe("MCP auth helpers (S11)", () => {
  it("parses an auth.toml token list", () => {
    expect(parseAuthToml('tokens = ["a", "b"]\n').sort()).toEqual(["a", "b"]);
  });

  it("extracts a token from authInfo or _meta", () => {
    expect(tokenFromMcp({ _meta: { token: "m" } }, undefined)).toBe("m");
    expect(tokenFromMcp({}, { authInfo: { token: "ai" } })).toBe("ai");
    expect(tokenFromMcp({}, undefined)).toBeNull();
  });

  it("disables auth when no token configured", () => {
    const auth = new TokenAuth({ env: {} as NodeJS.ProcessEnv, configPath: "/nope.toml" });
    expect(auth.enabled).toBe(false);
    expect(auth.verify(null)).toBe(true);
  });
});

async function connectedClient(auth: TokenAuth) {
  // list_pipelines needs only registry.listPipelines; use a minimal kernel stub.
  const server = buildMcpServer(
    {
      registry: { listPipelines: async () => ["p1"] },
    } as unknown as Parameters<typeof buildMcpServer>[0],
    { auth },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP tool-call auth (S11)", () => {
  it("rejects a tool call with no token when auth is enabled", async () => {
    const auth = new TokenAuth({ env: { CALANE_API_TOKEN: "secret" } as NodeJS.ProcessEnv });
    const client = await connectedClient(auth);
    const res = (await client.callTool({ name: "list_pipelines", arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/unauthorized/);
    await client.close();
  });

  it("rejects a tool call with an invalid token", async () => {
    const auth = new TokenAuth({ env: { CALANE_API_TOKEN: "secret" } as NodeJS.ProcessEnv });
    const client = await connectedClient(auth);
    const res = (await client.callTool({
      name: "list_pipelines",
      arguments: {},
      _meta: { token: "wrong" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    await client.close();
  });

  it("accepts a tool call with a valid token in _meta", async () => {
    const auth = new TokenAuth({ env: { CALANE_API_TOKEN: "secret" } as NodeJS.ProcessEnv });
    const client = await connectedClient(auth);
    const res = (await client.callTool({
      name: "list_pipelines",
      arguments: {},
      _meta: { token: "secret" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("p1");
    await client.close();
  });
});

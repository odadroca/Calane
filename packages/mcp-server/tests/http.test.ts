import { type KeyObject, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { TokenAuth } from "../src/auth.js";
import { startHttpMcpServer } from "../src/http.js";
import { JwksClient, JwtVerifier, type OidcConfig } from "../src/oidc.js";

/**
 * R1 integration test: drive the real Streamable HTTP transport in-process
 * against a localhost Node HTTP server (no external network, no live client).
 * Uses the project's example registry so list_pipelines returns real ids.
 */

interface Started {
  close: () => Promise<void>;
  url: string;
}

async function startServer(
  opts: {
    auth?: TokenAuth;
    oidc?: JwtVerifier;
  } = {},
): Promise<Started> {
  const { server, close } = await startHttpMcpServer(0, {
    auth: opts.auth,
    oidc: opts.oidc,
    // Use the repo's example registry; default store is fine for read tools.
    kernel: undefined,
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { close, url: `http://127.0.0.1:${port}/mcp` };
}

// --- OAuth/OIDC test helpers (mock JWKS via injected fetch; node:crypto only) -
const ISSUER = "https://idp.example.test/";
const AUDIENCE = "calane-mcp";
const KID = "mcp-key-1";
const OIDC_CONFIG: OidcConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUri: "https://idp.example.test/.well-known/jwks.json",
};

function makeKeys(): { privateKey: KeyObject; jwks: { keys: unknown[] } } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = KID;
  return { privateKey, jwks: { keys: [jwk] } };
}

function signJwt(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = cryptoSign("RSA-SHA256", Buffer.from(`${head}.${payload}`), privateKey).toString(
    "base64url",
  );
  return `${head}.${payload}.${sig}`;
}

function makeVerifier(jwks: { keys: unknown[] }): JwtVerifier {
  return new JwtVerifier(OIDC_CONFIG, {
    jwks: new JwksClient(OIDC_CONFIG.jwksUri, {
      fetchImpl: async () => ({ ok: true, json: async () => jwks }),
    }),
  });
}

async function connectClient(
  url: string,
  token?: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: async () => client.close() };
}

let teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const t of teardown) await t();
  teardown = [];
});

describe("Streamable HTTP MCP transport (R1)", () => {
  it("serves tools/list with exactly the 8 tools over HTTP", async () => {
    const { close, url } = await startServer();
    teardown.push(close);
    const { client, close: closeClient } = await connectClient(url);
    teardown.push(closeClient);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(8);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "export_run_bundle",
        "get_pipeline_spec",
        "get_run_result",
        "list_pipelines",
        "list_runs",
        "rerun_channel",
        "run_pipeline",
        "validate_pipeline",
      ].sort(),
    );
  });

  it("serves tools/call (list_pipelines) over HTTP", async () => {
    const { close, url } = await startServer();
    teardown.push(close);
    const { client, close: closeClient } = await connectClient(url);
    teardown.push(closeClient);

    const res = (await client.callTool({ name: "list_pipelines", arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    const payload = JSON.parse(res.content[0]!.text);
    expect(Array.isArray(payload.pipelines)).toBe(true);
  });

  it("rejects a tool call without a token when auth is enabled", async () => {
    const auth = new TokenAuth({ env: { CALANE_API_TOKEN: "secret-h" } as NodeJS.ProcessEnv });
    const { close, url } = await startServer({ auth });
    teardown.push(close);
    const { client, close: closeClient } = await connectClient(url); // no token
    teardown.push(closeClient);

    const res = (await client.callTool({ name: "list_pipelines", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/unauthorized/);
  });

  it("accepts a tool call with a valid bearer token when auth is enabled", async () => {
    const auth = new TokenAuth({ env: { CALANE_API_TOKEN: "secret-h" } as NodeJS.ProcessEnv });
    const { close, url } = await startServer({ auth });
    teardown.push(close);
    const { client, close: closeClient } = await connectClient(url, "secret-h");
    teardown.push(closeClient);

    const res = (await client.callTool({ name: "list_pipelines", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text);
    expect(Array.isArray(payload.pipelines)).toBe(true);
  });

  it("accepts a tool call with a valid OAuth access token (R2 dual auth)", async () => {
    const { privateKey, jwks } = makeKeys();
    // No static token configured; OAuth verifier is the only auth path.
    const auth = new TokenAuth({ env: {} as NodeJS.ProcessEnv, configPath: "/nope.toml" });
    const { close, url } = await startServer({ auth, oidc: makeVerifier(jwks) });
    teardown.push(close);
    const token = signJwt(privateKey, {
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const { client, close: closeClient } = await connectClient(url, token);
    teardown.push(closeClient);

    const res = (await client.callTool({ name: "list_pipelines", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text);
    expect(Array.isArray(payload.pipelines)).toBe(true);
  });

  it("rejects an invalid OAuth token when only OIDC auth is enabled", async () => {
    const { jwks } = makeKeys();
    const other = makeKeys(); // token signed by a different (unknown) key
    const auth = new TokenAuth({ env: {} as NodeJS.ProcessEnv, configPath: "/nope.toml" });
    const { close, url } = await startServer({ auth, oidc: makeVerifier(jwks) });
    teardown.push(close);
    const bad = signJwt(other.privateKey, { iss: ISSUER, aud: AUDIENCE });
    const { client, close: closeClient } = await connectClient(url, bad);
    teardown.push(closeClient);

    const res = (await client.callTool({ name: "list_pipelines", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/unauthorized/);
  });
});
